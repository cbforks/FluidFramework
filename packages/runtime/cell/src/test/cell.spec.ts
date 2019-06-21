/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { MockRuntime } from "@prague/runtime-test-utils";
import * as assert from "assert";
import { CellExtension, ICell } from "..";

describe("Routerlicious", () => {
    describe("Api", () => {
        describe("cell", () => {
            let testCell: ICell;

            beforeEach(async () => {
                const extension = new CellExtension();
                testCell = extension.create(new MockRuntime(), "cell");
            });

            it("Can create a cell", () => {
                assert.ok(testCell);
            });

            it("Can set and get cell data", async () => {
                await testCell.set("testValue");
                assert.equal(await testCell.get(), "testValue");
            });

        });
    });
});
