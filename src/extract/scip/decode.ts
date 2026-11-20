// A decoder of index.scip, SCIP's protobuf index, written by hand from SCIP's schema
// (scip.proto beside this file; SCIP by Sourcegraph, Apache-2.0). It is a reader of protobuf's
// wire format that keeps the fields hakutaku uses and skips every other field by its wire
// type, so hakutaku needs no protobuf library.
//
// It reads Index.documents (2); Document.relative_path (1), occurrences (2) and
// position_encoding (6); and Occurrence.range (1), symbol (2), symbol_roles (3) and
// enclosing_range (7). A repeated number may come packed or one value at a time, and an index
// may come in parts: scip-typescript writes one Index message per document, one after another,
// which protobuf reads as one Index. The engines hakutaku pins write ranges in the packed range
// field only; the typed ranges a newer schema adds (fields 8 to 11) are skipped.

export interface ScipOccurrence {
  range: number[];
  symbol: string;
  roles: number;
  enclosingRange: number[];
}

export interface ScipDocument {
  relativePath: string;
  positionEncoding: number;
  occurrences: ScipOccurrence[];
}

export interface ScipIndex {
  documents: ScipDocument[];
}

const VARINT = 0;
const FIXED64 = 1;
const LENGTH = 2;
const START_GROUP = 3;
const END_GROUP = 4;
const FIXED32 = 5;

// A protobuf string is UTF-8, and a leading U+FEFF in it is a character, not a byte order mark.
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

export function decodeScipIndex(bytes: Uint8Array): ScipIndex {
  const r = new Reader(bytes);
  const end = bytes.length;
  const documents: ScipDocument[] = [];
  while (r.pos < end) {
    r.key(end);
    if (r.field === 2) {
      r.expect(LENGTH, "Index.documents");
      documents.push(readDocument(r, r.lengthEnd(end)));
    } else {
      r.skip(end);
    }
  }
  return { documents };
}

function readDocument(r: Reader, end: number): ScipDocument {
  const doc: ScipDocument = {
    relativePath: "",
    positionEncoding: 0,
    occurrences: [],
  };
  while (r.pos < end) {
    r.key(end);
    switch (r.field) {
      case 1:
        r.expect(LENGTH, "Document.relative_path");
        doc.relativePath = r.string(end);
        break;
      case 2:
        r.expect(LENGTH, "Document.occurrences");
        doc.occurrences.push(readOccurrence(r, r.lengthEnd(end)));
        break;
      case 6:
        r.expect(VARINT, "Document.position_encoding");
        doc.positionEncoding = r.int32(end);
        break;
      default:
        r.skip(end);
    }
  }
  return doc;
}

function readOccurrence(r: Reader, end: number): ScipOccurrence {
  const occ: ScipOccurrence = {
    range: [],
    symbol: "",
    roles: 0,
    enclosingRange: [],
  };
  while (r.pos < end) {
    r.key(end);
    switch (r.field) {
      case 1:
        r.ints(end, occ.range, "Occurrence.range");
        break;
      case 2:
        r.expect(LENGTH, "Occurrence.symbol");
        occ.symbol = r.string(end);
        break;
      case 3:
        r.expect(VARINT, "Occurrence.symbol_roles");
        occ.roles = r.int32(end);
        break;
      case 7:
        r.ints(end, occ.enclosingRange, "Occurrence.enclosing_range");
        break;
      default:
        r.skip(end);
    }
  }
  return occ;
}

// A cursor over the bytes. Every read is given the end of the message it reads in, and fails
// rather than read past it.
class Reader {
  pos = 0;
  // the field number and wire type of the key read last
  field = 0;
  wire = 0;

  constructor(private readonly bytes: Uint8Array) {}

  fail(why: string): never {
    throw new Error(
      `index.scip is not a SCIP index: ${why} at byte ${this.pos}`,
    );
  }

  key(end: number): void {
    const key = this.uint(end);
    this.field = Math.floor(key / 8);
    this.wire = key % 8;
    if (this.field === 0) this.fail("a field numbered 0");
  }

  expect(wire: number, name: string): void {
    if (this.wire !== wire) this.fail(`${name} has wire type ${this.wire}`);
  }

  // A varint as an unsigned number, exact up to 2^53: enough for a key or a length.
  uint(end: number): number {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= end) this.fail("a varint runs past its end");
      const b = this.bytes[this.pos++] as number;
      value += (b & 0x7f) * scale;
      if (b < 0x80) return value;
      scale *= 128;
    }
    return this.fail("a varint is longer than ten bytes");
  }

  // A varint as protobuf reads an int32 or an enum: its low 32 bits, signed. A negative value
  // is written in ten bytes.
  int32(end: number): number {
    let value = 0;
    for (let shift = 0; shift < 70; shift += 7) {
      if (this.pos >= end) this.fail("a varint runs past its end");
      const b = this.bytes[this.pos++] as number;
      if (shift < 32) value |= (b & 0x7f) << shift;
      if (b < 0x80) return value;
    }
    return this.fail("a varint is longer than ten bytes");
  }

  // The end of the length-delimited value that starts here.
  lengthEnd(end: number): number {
    const n = this.uint(end);
    if (n > end - this.pos) this.fail("a length runs past its end");
    return this.pos + n;
  }

  string(end: number): string {
    const stop = this.lengthEnd(end);
    const text = utf8.decode(this.bytes.subarray(this.pos, stop));
    this.pos = stop;
    return text;
  }

  // The values of a repeated int32 field, packed or one at a time, added to `into`.
  ints(end: number, into: number[], name: string): void {
    if (this.wire === VARINT) {
      into.push(this.int32(end));
    } else if (this.wire === LENGTH) {
      const stop = this.lengthEnd(end);
      while (this.pos < stop) into.push(this.int32(stop));
    } else {
      this.fail(`${name} has wire type ${this.wire}`);
    }
  }

  // Skips the value of the field whose key was read last.
  skip(end: number): void {
    switch (this.wire) {
      case VARINT:
        this.uint(end);
        return;
      case FIXED64:
        this.advance(8, end);
        return;
      case LENGTH:
        this.pos = this.lengthEnd(end);
        return;
      case FIXED32:
        this.advance(4, end);
        return;
      case START_GROUP:
        this.skipGroup(end);
        return;
      case END_GROUP:
        this.fail(`group ${this.field} ends where none started`);
        return;
      default:
        this.fail(`wire type ${this.wire}`);
    }
  }

  // Skips the fields of the group whose start was read last, through its end.
  private skipGroup(end: number): void {
    const group = this.field;
    for (;;) {
      if (this.pos >= end) this.fail(`group ${group} never ends`);
      this.key(end);
      if (this.wire === END_GROUP) {
        if (this.field !== group) {
          this.fail(`group ${group} is ended as group ${this.field}`);
        }
        return;
      }
      this.skip(end);
    }
  }

  private advance(n: number, end: number): void {
    if (n > end - this.pos) this.fail("a fixed-size value runs past its end");
    this.pos += n;
  }
}
