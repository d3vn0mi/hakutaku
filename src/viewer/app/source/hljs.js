// The highlight.js the viewer bundles: its core, with only the grammars the Source tab uses
// registered, under the names of HlLanguage (languages.ts); xml is there for the JSX in
// JavaScript and TypeScript. No DOM here: Node tests and the highlighting worker import it.
//
// This one module is a script, with its types in hljs.d.ts, so that no program reads
// highlight.js's own declarations: they bring the DOM library into every program that reads
// them, and the program that typechecks the Node tests must have none.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("xml", xml);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("markdown", markdown);

export default hljs;
