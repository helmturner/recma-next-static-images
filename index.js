import { visit, SKIP, CONTINUE } from "estree-util-visit";
import fs from "node:fs";
import nodePath from "node:path";
import { URL } from "node:url";
import crypto from "node:crypto";
import nodeFetch from "node-fetch";
/**
 * Find the local identifier assigned to the imported JSX factory(s)
 * @example: `import theFactory from 'jsx'
 */
const getJsxFactorySpecifiers = (tree) => {
    const names = new Set();
    visit(tree, (node) => {
        if (node.type === "ImportSpecifier" &&
            "imported" in node &&
            /^jsxs?$/.test(node.imported.name)) {
            console.log("_IMPORT SPECIFIER", JSON.stringify(node));
            names.add(node.local.name);
            return SKIP;
        }
        return CONTINUE;
    });
    return names;
};
const makeImportDeclaration = (path, index) => ({
    source: {
        type: "Literal",
        value: path,
    },
    specifiers: [
        {
            type: "ImportDefaultSpecifier",
            local: {
                name: `static_image_${index}`,
                type: "Identifier",
            },
        },
    ],
    type: "ImportDeclaration",
});
const getCachePath = (cache, buffer, extension) => {
    const hash = crypto.createHash("sha256").update(buffer).digest("base64");
    return `${cache}/${hash}${extension ? `.${extension}` : ""}`;
};
const mutateProperty = (index) => ({
    type: "Property",
    key: {
        type: "Identifier",
        name: "src",
    },
    value: {
        type: "Identifier",
        name: `static_image_${index}`,
    },
    kind: "init",
    method: false,
    shorthand: false,
    computed: false,
});
const recmaStaticImages = function (options) {
    console.log("activated plugin");
    const { cacheDirectory, fetcher = nodeFetch } = options ?? {};
    if (cacheDirectory === undefined || cacheDirectory === null) {
        throw new Error(`Required option 'cacheDirectory' not provided`);
    }
    const cache = nodePath.resolve(cacheDirectory).replace(/\/+$/, "");
    console.log("CACHE_DIR", cache);
    if (!fs.existsSync(cache))
        fs.mkdirSync(cache);
    return async function (tree, vfile) {
        console.log("In ur transformer");
        console.log("_VFILE", JSON.stringify(vfile, undefined, "  "));
        if (!vfile.history[0]) {
            throw new Error(`Expected vfile history to be non-empty for vfile: ${vfile}`);
        }
        const jsxFactorySpecifiers = getJsxFactorySpecifiers(tree);
        let imageCounter = 0;
        const sourceDirectory = vfile.history[0].replace(/[^/]*$/, "");
        console.log(sourceDirectory);
        const imports = [];
        await visitAsync(tree, (node) => (node.type === "CallExpression" &&
            "callee" in node &&
            node.callee.type === "Identifier" &&
            jsxFactorySpecifiers.has(node.callee.name) &&
            node.arguments[0] &&
            node.arguments[0].type === "MemberExpression" &&
            node.arguments[0].property.type === "Identifier" &&
            node.arguments[0].property.name === "img" &&
            node.arguments[1] &&
            node.arguments[1].type === "ObjectExpression") ||
            false, imageSourceVisitor);
        await visitAsync(tree, (node) => node.type === "Program", async function (node) {
            console.log(JSON.stringify(imports));
            for (const declaration of imports) {
                if (declaration)
                    node.body.unshift(declaration);
            }
        });
        return;
        async function imageSourceVisitor(node) {
            console.log("_VISITOR_2 NODE");
            console.log("FOUND CANDIDATE", JSON.stringify(node));
            const [argument0, argument1, ...rest] = node.arguments;
            const newProperties = [];
            for (const property of argument1.properties) {
                if (property.type !== "Property" ||
                    property.key.type !== "Identifier" ||
                    property.key.name !== "src" ||
                    property.value.type !== "Literal" ||
                    typeof property.value.value !== "string") {
                    newProperties.push(property);
                    continue;
                }
                const value = property.value.value;
                const extension = value.split(".").pop();
                let url;
                let buffer;
                imageCounter += 1;
                try {
                    url = new URL(value);
                    console.log("REMOTE URL ENCOUNTERED:", url);
                }
                catch {
                    const source = nodePath.resolve(sourceDirectory, value);
                    console.log("LOCAL FILE ENCOUNTERED:", source);
                    buffer = fs.readFileSync(source);
                }
                if (url instanceof URL) {
                    const response = await fetcher.call(undefined, url.href);
                    if (!response || !response.body)
                        throw new Error(`Missing body in response for resource: ${url}`);
                    buffer = response.body.read();
                }
                if (!buffer) {
                    newProperties.push(property);
                    continue;
                }
                const path = getCachePath(cache, buffer, extension);
                fs.writeFileSync(path, buffer);
                const declaration = makeImportDeclaration(path, imageCounter);
                imports.push(declaration);
                newProperties.push(mutateProperty(imageCounter));
            }
            console.log("_NEWPROPS", JSON.stringify(newProperties, undefined, "  "));
            node.arguments = [
                argument0,
                { ...argument1, properties: newProperties },
                ...rest,
            ];
        }
    };
};
export default recmaStaticImages;
async function visitAsync(tree, test, asyncVisitor) {
    const matches = [];
    visit(tree, (node) => {
        if (test(node))
            matches.push(node);
    });
    const promises = matches.map((match) => asyncVisitor(match));
    await Promise.all(promises);
}
