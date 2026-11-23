// What hl.ts uses of the highlight.js that hljs.js sets up: highlighting a text in one of the
// registered languages into HTML whose markup is spans with classes, its text escaped.
declare const hljs: {
  highlight(
    code: string,
    options: { language: string; ignoreIllegals: boolean },
  ): { value: string };
};
export default hljs;
