// What reading a Word document into a form returns. Shared by the server
// that reads it and the screen that shows what was found.
export type Pair = { label: string; value: string };
export type Match = { fieldId: string; fieldLabel: string; kind: string; value: string; from: string; confidence: number };
export type Extraction = { common: Match[]; cases: { title: string; matches: Match[] }[]; unmatched: Pair[]; blocks: number };
