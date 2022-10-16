import type { Plugin } from "unified";
import type { Program } from "estree-jsx";
import { Response, type RequestInfo, type RequestInit } from "node-fetch";
export declare type Options = {
    cacheDirectory: string | undefined;
    fetcher: (input: RequestInfo, init?: RequestInit | undefined) => Promise<Response>;
} | null | undefined;
declare const recmaStaticImages: Plugin<[
    (Options | undefined | void)?
], Program, Program>;
export default recmaStaticImages;
//# sourceMappingURL=index.d.ts.map