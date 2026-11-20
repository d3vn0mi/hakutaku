// The SCIP decoder, over indexes built by the small protobuf encoder below. Field numbers are
// the schema's (src/extract/scip/scip.proto): Index has metadata 1, documents 2 and
// external_symbols 3; Document has relative_path 1, occurrences 2 and position_encoding 6;
// Occurrence has range 1, symbol 2, symbol_roles 3 and enclosing_range 7.
import { expect, it } from "vitest";
import { decodeScipIndex } from "../../../src/extract/scip/decode.js";

type Bytes = number[];

const utf8 = new TextEncoder();

// A value as a protobuf varint: seven bits a byte, least significant first. A negative number
// is its 64-bit two's complement, ten bytes, as protobuf writes a negative int32.
function varint(n: number | bigint): Bytes {
  let v = BigInt.asUintN(64, BigInt(n));
  const out: Bytes = [];
  for (;;) {
    const low = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n) {
      out.push(low);
      return out;
    }
    out.push(low | 0x80);
  }
}

const key = (field: number, wire: number): Bytes =>
  varint(BigInt(field) * 8n + BigInt(wire));
const len = (field: number, payload: Bytes): Bytes => [
  ...key(field, 2),
  ...varint(payload.length),
  ...payload,
];
const str = (field: number, s: string): Bytes =>
  len(field, [...utf8.encode(s)]);
const int = (field: number, n: number): Bytes => [
  ...key(field, 0),
  ...varint(n),
];
const packed = (field: number, ns: number[]): Bytes =>
  len(
    field,
    ns.flatMap((n) => varint(n)),
  );
const unpacked = (field: number, ns: number[]): Bytes =>
  ns.flatMap((n) => int(field, n));

interface Occ {
  range: number[];
  symbol?: string;
  roles?: number;
  enclosing?: number[];
}

const occurrence = (o: Occ, ranges = packed): Bytes => [
  ...ranges(1, o.range),
  ...(o.symbol === undefined ? [] : str(2, o.symbol)),
  ...(o.roles === undefined ? [] : int(3, o.roles)),
  ...(o.enclosing === undefined ? [] : ranges(7, o.enclosing)),
];

const document = (
  path: string,
  occurrences: Bytes[],
  encoding?: number,
): Bytes => [
  ...str(1, path),
  ...occurrences.flatMap((o) => len(2, o)),
  ...(encoding === undefined ? [] : int(6, encoding)),
];

// An Index message holding the given documents.
const documents = (...docs: Bytes[]): Bytes => docs.flatMap((d) => len(2, d));

const bytesOf = (...parts: Bytes[]): Uint8Array =>
  Uint8Array.from(parts.flat());

const ORBIT = "scip-typescript npm observatory 0.1.0 src/`orbit.ts`/";

it("decodes documents, occurrences and their roles", () => {
  // As scip-typescript writes an index: one Index message after another, each holding one
  // document, which protobuf reads as one Index.
  const bytes = bytesOf(
    documents(
      document("src/orbit.ts", [
        occurrence({
          range: [0, 0, 0],
          symbol: ORBIT,
          roles: 1,
          enclosing: [0, 0, 4, 1],
        }),
        occurrence({
          range: [1, 2, 10],
          symbol: `${ORBIT}Orbit#position().`,
          roles: 1,
          enclosing: [1, 2, 3, 3],
        }),
      ]),
    ),
    documents(
      document(
        "test/orbit.test.ts",
        [
          // no roles: a plain reference
          occurrence({ range: [0, 22, 36], symbol: ORBIT }),
          // read access (8) and import (2)
          occurrence({
            range: [2, 24, 32],
            symbol: `${ORBIT}Orbit#position().`,
            roles: 10,
          }),
          // no symbol
          occurrence({ range: [3, 0, 5] }),
        ],
        2,
      ),
    ),
    documents(document("src/empty.ts", [])),
  );
  expect(decodeScipIndex(bytes)).toStrictEqual({
    documents: [
      {
        relativePath: "src/orbit.ts",
        positionEncoding: 0,
        occurrences: [
          {
            range: [0, 0, 0],
            symbol: ORBIT,
            roles: 1,
            enclosingRange: [0, 0, 4, 1],
          },
          {
            range: [1, 2, 10],
            symbol: `${ORBIT}Orbit#position().`,
            roles: 1,
            enclosingRange: [1, 2, 3, 3],
          },
        ],
      },
      {
        relativePath: "test/orbit.test.ts",
        positionEncoding: 2,
        occurrences: [
          { range: [0, 22, 36], symbol: ORBIT, roles: 0, enclosingRange: [] },
          {
            range: [2, 24, 32],
            symbol: `${ORBIT}Orbit#position().`,
            roles: 10,
            enclosingRange: [],
          },
          { range: [3, 0, 5], symbol: "", roles: 0, enclosingRange: [] },
        ],
      },
      { relativePath: "src/empty.ts", positionEncoding: 0, occurrences: [] },
    ],
  });
  expect(decodeScipIndex(new Uint8Array(0))).toStrictEqual({ documents: [] });
});

it("decodes packed and unpacked ranges alike", () => {
  const occ: Occ = {
    range: [4, 2, 6, 1],
    symbol: "local 3",
    roles: 1,
    enclosing: [4, 0, 9, 1],
  };
  const asPacked = decodeScipIndex(
    bytesOf(documents(document("a.ts", [occurrence(occ, packed)]))),
  );
  const asUnpacked = decodeScipIndex(
    bytesOf(documents(document("a.ts", [occurrence(occ, unpacked)]))),
  );
  expect(asPacked.documents[0]?.occurrences).toStrictEqual([
    {
      range: [4, 2, 6, 1],
      symbol: "local 3",
      roles: 1,
      enclosingRange: [4, 0, 9, 1],
    },
  ]);
  expect(asUnpacked).toStrictEqual(asPacked);
  // A repeated field may come in parts, in both forms: they are read in order.
  const parts = [...packed(1, [4, 2]), ...unpacked(1, [6]), ...packed(1, [1])];
  expect(
    decodeScipIndex(bytesOf(documents(document("a.ts", [parts])))).documents[0]
      ?.occurrences[0]?.range,
  ).toStrictEqual([4, 2, 6, 1]);
  // a range number past seven bits takes two bytes, and one past 2^28 five
  expect(
    decodeScipIndex(
      bytesOf(documents(document("a.ts", [packed(1, [300, 2 ** 28 + 5, 7])]))),
    ).documents[0]?.occurrences[0]?.range,
  ).toStrictEqual([300, 2 ** 28 + 5, 7]);
});

it("skips fields it does not read", () => {
  // Metadata { version 1, tool_info 2 { name 1, version 2 }, project_root 3,
  // text_document_encoding 4 }
  const metadata = len(1, [
    ...int(1, 0),
    ...len(2, [...str(1, "scip-typescript"), ...str(2, "0.5.2")]),
    ...str(3, "file:///work/snapshot"),
    ...int(4, 1),
  ]);
  // SymbolInformation { symbol 1, documentation 3 }
  const external = len(3, [
    ...str(1, "scip-typescript npm typescript 6.0.3 lib/`lib.es5.d.ts`/Array#"),
    ...str(3, "An array."),
  ]);
  // A field of every other wire type: 64-bit (1), 32-bit (5), a group (3 to 4) holding a
  // nested group, and a negative varint, which takes ten bytes.
  const others: Bytes = [
    ...key(12, 1),
    ...[1, 2, 3, 4, 5, 6, 7, 8],
    ...key(13, 5),
    ...[1, 2, 3, 4],
    ...key(14, 3),
    ...int(1, 7),
    ...key(16, 3),
    ...str(2, "in a nested group"),
    ...key(16, 4),
    ...key(14, 4),
    ...int(15, -1),
    ...int(536_870_911, 9),
  ];
  const occ = [
    ...occurrence({ range: [0, 13, 18], symbol: `${ORBIT}Orbit#`, roles: 1 }),
    // override_documentation 4, syntax_kind 5, diagnostics 6, a typed range 8
    ...str(4, "class Orbit"),
    ...int(5, 6),
    ...len(6, [...int(1, 1), ...str(3, "an error")]),
    ...len(8, [...int(1, 0), ...int(2, 13), ...int(3, 18)]),
    ...others,
  ];
  const doc = [
    // language 4, symbols 3, text 5
    ...str(4, "TypeScript"),
    ...document("src/orbit.ts", [occ]),
    ...len(3, str(1, `${ORBIT}Orbit#`)),
    ...str(5, "export class Orbit {}\n"),
    ...others,
  ];
  expect(
    decodeScipIndex(bytesOf(metadata, external, len(2, doc), others)),
  ).toStrictEqual({
    documents: [
      {
        relativePath: "src/orbit.ts",
        positionEncoding: 0,
        occurrences: [
          {
            range: [0, 13, 18],
            symbol: `${ORBIT}Orbit#`,
            roles: 1,
            enclosingRange: [],
          },
        ],
      },
    ],
  });
});

it("reads an int32 as the low 32 bits of its varint, which a negative one fills in ten bytes", () => {
  const bytes = bytesOf(
    documents(
      document("a.ts", [occurrence({ range: [0, 0, 1], roles: -1 })], -2),
    ),
  );
  const doc = decodeScipIndex(bytes).documents[0];
  expect(doc?.positionEncoding).toBe(-2);
  expect(doc?.occurrences[0]?.roles).toBe(-1);
  // a longer varint than the value needs: the bits past the 32nd are dropped
  const long = bytesOf(
    documents(
      document("a.ts", [
        [...packed(1, [0, 0, 1]), ...key(3, 0), ...varint(1n + (1n << 35n))],
      ]),
    ),
  );
  expect(decodeScipIndex(long).documents[0]?.occurrences[0]?.roles).toBe(1);
});

it.each<[string, Bytes]>([
  ["a varint cut short", [0x80]],
  ["a length past the end", [...key(2, 2), ...varint(5), 1, 2]],
  ["wire type 6", key(9, 6)],
  ["wire type 7", key(9, 7)],
  ["an end group with no start", key(9, 4)],
  ["a group that never ends", [...key(9, 3), ...int(1, 1)]],
  ["a group ended by another field's end", [...key(9, 3), ...key(10, 4)]],
  ["field number 0", int(0, 1)],
  ["a varint of eleven bytes", [...key(9, 0), ...Array(10).fill(0x80), 1]],
  ["a document path written as a varint", len(2, int(1, 5))],
  ["an occurrence's symbol written as a varint", len(2, len(2, int(2, 5)))],
  [
    "a range written as a 64-bit field",
    len(2, len(2, [...key(1, 1), 0, 0, 0, 0, 0, 0, 0, 0])),
  ],
  [
    "a string longer than its document",
    len(2, [...key(1, 2), ...varint(9), 0x61]),
  ],
  [
    "a packed range whose last varint runs past its field",
    len(2, len(2, len(1, [0x80]))),
  ],
])("refuses %s", (_, bytes) => {
  expect(() => decodeScipIndex(Uint8Array.from(bytes))).toThrow(
    /^index\.scip is not a SCIP index: .+ at byte \d+$/,
  );
});
