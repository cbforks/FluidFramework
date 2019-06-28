/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import * as api from "@prague/container-definitions";
import { IDeltaStorageGetResponse, ISequencedDeltaOpMessage } from "./contracts";
import { getQueryString } from "./getQueryString";
import { IGetter } from "./Getter";
import { getWithRetryForTokenRefresh } from "./utils";

/**
 * Storage service limited to only being able to fetch documents for a specific document
 */
export class DocumentDeltaStorageService implements api.IDocumentDeltaStorageService {
    constructor(
        private readonly tenantId: string,
        private readonly id: string,
        private readonly tokenProvider: api.ITokenProvider,
        private readonly storageService: api.IDeltaStorageService) {
    }

    /* tslint:disable:promise-function-async */
    public get(from?: number, to?: number): Promise<api.ISequencedDocumentMessage[]> {
        return this.storageService.get(this.tenantId, this.id, this.tokenProvider, from, to);
    }
}

/**
 * Provides access to the underlying delta storage on the server for sharepoint driver.
 */
export class OdspDeltaStorageService implements api.IDeltaStorageService {
    private firstGetRequest = true;
    private readonly queryString: string;

    constructor(
        queryParams: { [key: string]: string },
        private readonly deltaFeedUrl: string,
        private readonly getter: IGetter,
        private ops: ISequencedDeltaOpMessage[] | undefined,
        private readonly getToken: (refresh: boolean) => Promise<string>,
    ) {
        this.queryString = getQueryString(queryParams);
    }

    public async get(
        tenantId: string | null,
        id: string | null,
        tokenProvider: api.ITokenProvider,
        from?: number,
        to?: number,
    ): Promise<api.ISequencedDocumentMessage[]> {
        if (this.firstGetRequest) {
            this.firstGetRequest = false;
            if (this.ops !== undefined && this.ops !== null && from) {
                const returnOps = this.ops;
                this.ops = undefined;

                // If cache is empty, it's much better to allow actual request to go through.
                // This request is asynchronous from POV of Container load sequence (when we start with snapshot)
                // But if we have a gap, we figure it out later in time (when websocket connects and we receive initial ops / first op),
                // and we will have to wait for actual data to come in - it's better to make this call earlier in time!
                if (returnOps.length > 0) {
                    return returnOps.filter((op) => op.sequenceNumber > from).map((op) => op.op);
                }
            }
        }

        let token: string;
        return getWithRetryForTokenRefresh(async (refresh: boolean) => {
            token = await this.getToken(refresh);
            const url = this.buildGetterUrl(token, from, to);
            return this.getter.get<IDeltaStorageGetResponse>(url, url, {}).then((response) => {
                const operations: api.ISequencedDocumentMessage[] | ISequencedDeltaOpMessage[] = response.value;
                if (operations.length > 0 && "op" in operations[0]) {
                    return (operations as ISequencedDeltaOpMessage[]).map((operation) => operation.op);
                }
                return operations as api.ISequencedDocumentMessage[];
            });
        });
    }

    public buildGetterUrl(token: string, from: number | undefined, to: number | undefined) {
        const fromInclusive = from === undefined ? undefined : from + 1;
        const toInclusive = to === undefined ? undefined : to - 1;

        const filter = encodeURIComponent(`sequenceNumber ge ${fromInclusive} and sequenceNumber le ${toInclusive}`);
        const fullQueryString =
            `${(this.queryString ? `${this.queryString}&` : "?")}filter=${filter}&access_token=${token}`;
        return `${this.deltaFeedUrl}${fullQueryString}`;
    }
}
