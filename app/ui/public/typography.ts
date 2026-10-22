// Explicitly request the face before measuring; fonts.ready alone can resolve before
// a not-yet-used face begins loading. Every browser owner keeps its own abort guard.
export async function typographyReady() {
  await document.fonts.load('760 18px "Google Sans Flex"');
  await document.fonts.ready;
}
