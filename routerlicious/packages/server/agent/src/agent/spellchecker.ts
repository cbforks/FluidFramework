import { ISequencedDocumentMessage } from "@prague/container-definitions";
import * as MergeTree from "@prague/merge-tree";
import * as Sequence from "@prague/sequence";
import { debug } from "./debug";

export interface IPgMarker {
    tile: MergeTree.Marker;

    pos: number;
}

export interface IRange {

    begin: number;

    end: number;
}

function compareProxStrings(a: MergeTree.ProxString<number>, b: MergeTree.ProxString<number>) {
    const ascore = ((a.invDistance * 200) * a.val) + a.val;
    const bscore = ((b.invDistance * 200) * b.val) + b.val;
    return bscore - ascore;
}

class Speller {
    private static altMax = 7;
    private static idleTimeMS = 500;
    private idleTimer = null;
    private currentIdleTime: number = 0;
    private pendingMarkers: IPgMarker[] = new Array<IPgMarker>();
    private tileMap: Map<MergeTree.ReferencePosition, IRange> = new Map<MergeTree.ReferencePosition, IRange>();
    private verbose = false;

    constructor(
        public sharedString: Sequence.SharedString,
        private dict: MergeTree.TST<number>) {
    }

    public initialSpellCheck() {
        const spellParagraph = (startPG: number, endPG: number, text: string) => {
            const re = /\b\w+\b/g;
            let result: RegExpExecArray;
            do {
                result = re.exec(text);
                if (result) {
                    const candidate = result[0];
                    if (this.spellingError(candidate.toLocaleLowerCase())) {
                        const start = result.index;
                        const end = re.lastIndex;
                        const textErrorInfo = this.makeTextErrorInfo(candidate);
                        if (this.verbose) {
                            debug(`spell (${startPG + start}, ${startPG + end}): ${textErrorInfo.text}`);
                        }
                        this.sharedString.annotateRange({ textError: textErrorInfo }, startPG + start, startPG + end);
                    }
                }
            } while (result);
        };
        let prevPG: MergeTree.Marker;
        let startPGPos = 0;
        let pgText = "";
        let endMarkerFound = false;
        const mergeTree = this.sharedString.client.mergeTree;
        function gatherPG(segment: MergeTree.ISegment, segpos: number) {
            switch (segment.getType()) {
                case MergeTree.SegmentType.Marker:
                    const marker = segment as MergeTree.Marker;
                    if (mergeTree.localNetLength(segment)) {
                        if (marker.hasTileLabel("pg")) {
                            if (prevPG) {
                                // TODO: send paragraph to service
                                spellParagraph(startPGPos, segpos, pgText);
                                endMarkerFound = true;
                            }
                            startPGPos = segpos + mergeTree.localNetLength(segment);
                            prevPG = marker;
                            pgText = "";
                            if (endMarkerFound) {
                                return false;
                            }
                        } else {
                            for (let i = 0; i < mergeTree.localNetLength(segment); i++) {
                                pgText += " ";
                            }
                        }
                    }
                    break;
                case MergeTree.SegmentType.Text:
                    const textSegment = segment as MergeTree.TextSegment;
                    if (mergeTree.localNetLength(textSegment)) {
                        pgText += textSegment.text;
                    }
                    break;
                default:
                    throw new Error("Unknown SegmentType");
            }
            return true;
        }

        do {
            endMarkerFound = false;
            this.sharedString.client.mergeTree.mapRange({ leaf: gatherPG }, MergeTree.UniversalSequenceNumber,
                this.sharedString.client.getClientId(), undefined, startPGPos);
        } while (endMarkerFound);

        if (prevPG) {
            // TODO: send paragraph to service
            spellParagraph(startPGPos, startPGPos + pgText.length, pgText);
        }

        this.setEvents();
    }

    public stop() {
        this.sharedString.removeAllListeners();
        if (!this.idleTimer) {
            return;
        }
        clearInterval(this.idleTimer);
        this.idleTimer = null;
    }

    private spellingError(word: string) {
        if (/\b\d+\b/.test(word)) {
            return false;
        } else {
            return !this.dict.contains(word);
        }
    }

    private setEvents() {
        const idleCheckerMS = Speller.idleTimeMS / 5;
        this.idleTimer = setInterval(() => {
            this.currentIdleTime += idleCheckerMS;
            if (this.currentIdleTime >= Speller.idleTimeMS) {
                this.sliceParagraph();
                this.currentIdleTime = 0;
            }
        }, idleCheckerMS);
        this.sharedString.on("op", (msg: ISequencedDocumentMessage) => {
            if (msg && msg.contents) {
                const delta = msg.contents as MergeTree.IMergeTreeOp;
                this.collectDeltas(delta);
                this.currentIdleTime = 0;
            }
        });
    }

    // Collects deltas and convert them into markers.
    private collectDeltas(delta: MergeTree.IMergeTreeOp) {
        if (delta.type === MergeTree.MergeTreeDeltaType.INSERT ||
            delta.type === MergeTree.MergeTreeDeltaType.REMOVE) {
            const pgRef = this.sharedString.client.mergeTree.findTile(delta.pos1,
                this.sharedString.client.getClientId(), "pg");
            let pgMarker: IPgMarker;
            if (!pgRef) {
                pgMarker = { tile: undefined, pos: 0 };
            } else {
                pgMarker = { tile: pgRef.tile as MergeTree.Marker, pos: pgRef.pos };
            }
            this.pendingMarkers.push(pgMarker);
        } else if (delta.type === MergeTree.MergeTreeDeltaType.GROUP) {
            for (const groupOp of delta.ops) {
                this.collectDeltas(groupOp);
            }
        }
    }

    private makeTextErrorInfo(candidate: string) {
        const alternates = this.dict.neighbors(candidate, 2).sort(compareProxStrings);
        if (alternates.length > Speller.altMax) {
            alternates.length = Speller.altMax;
        }
        return {
            alternates,
            text: candidate,
        };
    }

    // Slices paragraph based on previously collected markers. For dedeuplication, uses a map with tile as hash key.
    private sliceParagraph() {
        if (this.pendingMarkers.length > 0) {
            for (const pg of this.pendingMarkers) {
                let offset = 0;
                if (pg.tile) {
                    offset = this.sharedString.client.mergeTree.getOffset(pg.tile, MergeTree.UniversalSequenceNumber,
                        this.sharedString.client.getClientId());
                }
                const endMarker = this.sharedString.client.mergeTree.findTile(offset + 1,
                    this.sharedString.client.getClientId(), "pg", false);
                if (endMarker) {
                    this.tileMap.set(endMarker.tile, {begin: offset, end: endMarker.pos});
                }
            }
            for (const entry of this.tileMap.entries()) {
                const range = entry[1];
                let endPos: number;
                if (entry[0]) {
                    endPos = range.end;
                } else {
                    endPos = this.sharedString.client.mergeTree.getLength(MergeTree.UniversalSequenceNumber,
                        this.sharedString.client.getClientId());
                }
                const queryString = this.sharedString.getText(range.begin, endPos);
                const newRange: IRange = {
                    begin: range.begin + 1,
                    end: endPos + 1,
                };
                this.runtimeSpellCheck(newRange.begin, newRange.end, queryString);
            }
            this.pendingMarkers = [];
            this.tileMap.clear();
        }
    }

    private runtimeSpellCheck(beginPos: number, endPos: number, text: string) {
        const re = /\b\w+\b/g;
        let result: RegExpExecArray;
        let runningStart = beginPos;
        do {
            result = re.exec(text);
            if (result) {
                const start = result.index + beginPos;
                const end = re.lastIndex + beginPos;
                const candidate = result[0];
                if (this.spellingError(candidate.toLocaleLowerCase())) {
                    if (start > runningStart) {
                        this.sharedString.annotateRange({ textError: null }, runningStart, start);
                    }
                    const textErrorInfo = this.makeTextErrorInfo(candidate);
                    if (this.verbose) {
                        debug(`respell (${start}, ${end}): ${textErrorInfo.text}`);
                        let buf = "alternates: ";
                        for (const alt of textErrorInfo.alternates) {
                            buf += ` ${alt.text}:${alt.invDistance}:${alt.val}`;
                        }
                        debug(buf);
                    }
                    this.sharedString.annotateRange({ textError: textErrorInfo }, start, end);
                    runningStart = end;
                }
            }
        }
        while (result);
        if (endPos > runningStart) {
            this.sharedString.annotateRange({ textError: null }, runningStart, endPos);
        }
    }
}

export class Spellcheker {
    private speller: Speller;

    constructor(
        private root: Sequence.SharedString,
        private dict: MergeTree.TST<number>) {
    }

    public run() {
        this.root.loaded.then(() => {
            this.speller = new Speller(this.root, this.dict);
            this.speller.initialSpellCheck();
        });
    }

    public stop() {
        this.speller.stop();
    }
}
