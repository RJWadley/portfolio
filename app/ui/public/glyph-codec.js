// Generated geometry stays compressed until its lazy module is requested.
export async function packedGlyphReader(encoded) {
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const buffer = await new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate")),
  ).arrayBuffer();
  const data = new Uint8Array(buffer),
    view = new DataView(buffer);
  let at = 0;
  return {
    u() {
      let value = 0,
        shift = 0,
        byte;
      do {
        byte = data[at++];
        value += (byte & 127) * 2 ** shift;
        shift += 7;
      } while (byte & 128);
      return value;
    },
    s() {
      const value = this.u();
      return value % 2 ? -(value + 1) / 2 : value / 2;
    },
    f64() {
      const value = view.getFloat64(at, true);
      at += 8;
      return value;
    },
  };
}
