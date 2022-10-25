import type * as Node from "node-fetch";
import type * as Unified from "unified";
import type * as ESTree from "estree-jsx";
export declare type Options = {
    cacheDirectory: string | undefined;
    customFetch: (input: Node.RequestInfo, init?: Node.RequestInit | undefined) => Promise<Node.Response>;
} | null | undefined;
declare const recmaStaticImages: Unified.Plugin<[
    (Options | undefined | void)?
], ESTree.Program, ESTree.Program>;
export default recmaStaticImages;
//# sourceMappingURL=index.d.ts.map