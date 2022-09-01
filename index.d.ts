import type { Plugin } from "unified";
import type { Program } from "estree-jsx";
declare type Options = {
    cacheDir: string | undefined;
} | null | undefined;
declare const recmaStaticImages: Plugin<[
    (Options | undefined | void)?
], Program, Program>;
export default recmaStaticImages;
//# sourceMappingURL=index.d.ts.map