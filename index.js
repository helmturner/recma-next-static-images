import { visit, SKIP, EXIT, CONTINUE } from "estree-util-visit";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import crypto from "node:crypto";
import nodeFetch, { Response, } from "node-fetch";
const parseRetryAfterHeader = (response) => {
    if (!(response instanceof Response))
        throw new TypeError(`Expected 'response' to be an instance of 'Response'}`);
    const retryHeader = response.headers.get("retry-after");
    if (retryHeader === null || retryHeader === undefined)
        return;
    if (retryHeader.length > 30) {
        throw new Error(`Requested resource ${response.url} received a response with a 'retry-after' header that is too long: (${retryHeader})`);
    }
    if (/^\d+$/.test(retryHeader)) {
        const asNumber = Number.parseInt(retryHeader);
        if (asNumber > 10000) {
            throw new Error(`Requested resource ${response.url} received a response with a 'retry-after' header greater than 10 seconds in the future: (${retryHeader})`);
        }
        return asNumber;
    }
    return Date.parse(retryHeader) - Date.now();
};
const wait = (ms = 0) => {
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve();
        }, ms);
    });
};
/**
 * Returns a custom implementation of fetch that retries
 * certain responses according to the arguments provided
 */
const makeRetryableFetcher = (options) => {
    const { retries = 5, delay = 500, test = (r) => [408, 409, 429, 500, 502, 503, 504].includes(r.status), } = options || {};
    if (typeof retries !== "number")
        throw new TypeError(`Invalid Parameters; Expected 'retries' to be a number, got: ${typeof retries}`);
    if (typeof delay !== "number" && typeof delay !== "function") {
        throw new TypeError(`Invalid Parameters; Expected 'delay' to be a number or a function returning a number, got: ${typeof delay}`);
    }
    if (typeof test !== "function")
        throw new TypeError(`Invalid Parameters; Expected 'test' to be a function, got: ${typeof delay}`);
    let attempts = 0;
    /* By creating a closure we allow the generated fetcher to
      track it's own retries, since they are in scope.
      JS classes are just syntactic sugar, so we don't need them! */
    const fetcher = async (input, init) => {
        attempts += 1;
        return nodeFetch(input, init)
            .then(async (result) => {
            let _delay = typeof delay === "function" ? delay(attempts) : delay;
            if (test(result) && attempts < retries) {
                _delay = parseRetryAfterHeader(result) ?? _delay;
                console.warn({
                    message: `Request failed, retrying in ${_delay} seconds...`,
                    error: result.statusText,
                });
                await wait(_delay);
                return fetcher(input, init);
            }
            return result;
        })
            .catch(async (error) => {
            const _delay = typeof delay === "function" ? delay(attempts) : delay;
            if (attempts < retries) {
                console.warn({
                    message: `Request failed, retrying in ${delay} seconds...`,
                    error: "message" in error ? error.message : `${error}`,
                });
                await wait(_delay);
                return fetcher(input, init);
            }
            throw error;
        });
    };
    return fetcher;
};
const recmaStaticImages = function (options) {
    const { cacheDirectory } = options ?? {};
    if (cacheDirectory === undefined || cacheDirectory === null) {
        throw new Error(`Required option 'cacheDirectory' not provided`);
    }
    const resolvedCacheDirectory = path.resolve(cacheDirectory);
    console.log("__RESOLVED_CACHE_DIR", resolvedCacheDirectory);
    console.log("activated plugin");
    return function (tree, vfile) {
        console.log("In ur transformer");
        const jsxFactorySpecifiers = new Set();
        if (!fs.existsSync(resolvedCacheDirectory))
            fs.mkdirSync(resolvedCacheDirectory);
        const cache = resolvedCacheDirectory.replace(/\/+$/, "");
        const imports = [];
        let imageCounter = 0;
        visit(tree, (node) => {
            if (node.type === "ImportSpecifier" &&
                "imported" in node &&
                /^jsxs?$/.test(node.imported.name)) {
                console.log("_IMPORT SPECIFIER", JSON.stringify(node));
                jsxFactorySpecifiers.add(node.local.name);
                return SKIP;
            }
            return CONTINUE;
        });
        visit(tree, {
            enter: function (node) {
                console.log("_VISITOR_2 NODE");
                if (node.type === "CallExpression" &&
                    "callee" in node &&
                    node.callee.type === "Identifier" &&
                    jsxFactorySpecifiers.has(node.callee.name) &&
                    node.arguments[0] &&
                    node.arguments[0].type === "MemberExpression" &&
                    node.arguments[0].property.type === "Identifier" &&
                    node.arguments[0].property.name === "img" &&
                    node.arguments[1] &&
                    node.arguments[1].type === "ObjectExpression") {
                    console.log("FOUND CANDIDATE", JSON.stringify(node));
                    const [argument0, argument1, ...rest] = node.arguments;
                    const newProperties = argument1.properties.map((property) => {
                        if (property.type !== "Property" ||
                            property.key.type !== "Identifier" ||
                            property.key.name !== "src" ||
                            property.value.type !== "Literal" ||
                            typeof property.value.value !== "string") {
                            return property;
                        }
                        imageCounter += 1;
                        if (!vfile.history[0])
                            throw new Error(`Expected vfile history to be non-empty for vfile: ${vfile}`);
                        const directory = vfile.history[0].replace(/[^/]*$/, "");
                        console.log(directory);
                        const source = path.resolve(directory, property.value.value);
                        console.log(source);
                        const extension = source.split(".").pop();
                        let url;
                        try {
                            url = new URL(source);
                        }
                        catch {
                            console.log(source);
                            console.log("_VFILE", JSON.stringify(vfile, undefined, "  "));
                            const buffer = fs.readFileSync(source);
                            const hash = crypto
                                .createHash("sha256")
                                .update(buffer)
                                .digest("base64");
                            const path = `${cache}/${hash}${extension ? `.${extension}` : ""}`;
                            fs.writeFileSync(path, buffer);
                            imports.push({
                                source: {
                                    type: "Literal",
                                    value: path,
                                },
                                specifiers: [
                                    {
                                        type: "ImportDefaultSpecifier",
                                        local: {
                                            name: `static_image_${imageCounter}`,
                                            type: "Identifier",
                                        },
                                    },
                                ],
                                type: "ImportDeclaration",
                            });
                            const returnValue = {
                                type: "Property",
                                key: {
                                    type: "Identifier",
                                    name: "src",
                                },
                                value: {
                                    type: "Identifier",
                                    name: `static_image_${imageCounter}`,
                                },
                                kind: "init",
                                method: false,
                                shorthand: false,
                                computed: false,
                            };
                            return returnValue;
                        }
                        if (url instanceof URL) {
                            const fetcher = makeRetryableFetcher({
                                retries: 5,
                                delay: 3000,
                            });
                            fetcher.call(undefined, url.href).then((response) => {
                                if (!response || !response.body)
                                    throw new Error(`Missing body in response for resource: ${url}`);
                                const buffer = response.body.read();
                                const hash = crypto
                                    .createHash("sha256")
                                    .update(buffer)
                                    .digest("base64");
                                const path = `${cache}/${hash}${extension ? `.${extension}` : ""}`;
                                fs.writeFileSync(path, buffer);
                                imports.push({
                                    source: {
                                        type: "Literal",
                                        value: path,
                                    },
                                    specifiers: [
                                        {
                                            type: "ImportDefaultSpecifier",
                                            local: {
                                                name: `static_image_${imageCounter}`,
                                                type: "Identifier",
                                            },
                                        },
                                    ],
                                    type: "ImportDeclaration",
                                });
                                const returnValue = {
                                    type: "Property",
                                    key: {
                                        type: "Identifier",
                                        name: "src",
                                    },
                                    value: {
                                        type: "Identifier",
                                        name: `static_image_${imageCounter}`,
                                    },
                                    kind: "init",
                                    method: false,
                                    shorthand: false,
                                    computed: false,
                                };
                                return returnValue;
                            });
                        }
                        return property;
                    });
                    console.log("_NEWPROPS", JSON.stringify(newProperties, undefined, "  "));
                    node = {
                        ...node,
                        arguments: [
                            argument0,
                            { ...argument1, properties: newProperties },
                            ...rest,
                        ],
                    };
                }
                return CONTINUE;
            },
            leave: function (node) {
                if (node.type === "Program" && "body" in node) {
                    for (const imported of imports) {
                        if (imported)
                            node.body.unshift(imported);
                    }
                    return EXIT;
                }
                return SKIP;
            },
        });
        return;
    };
};
export default recmaStaticImages;
