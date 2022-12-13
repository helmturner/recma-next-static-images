/* eslint-disable unicorn/numeric-separators-style */
import node_fs from "node:fs";
import async_node_fs from "node:fs/promises";
import node_path from "node:path";
import node_fetch from "node-fetch";
import node_crypto from "node:crypto";
import { visit, SKIP, CONTINUE } from "estree-util-visit";
import { randomUUID } from "node:crypto";

import type * as NodeFetch from "node-fetch";
import type * as Unified from "unified";
import type * as ESTreeJsx from "estree-jsx";
import type * as TreeWalker from "estree-util-visit";

const uuid = () => randomUUID().replace(/-/g, "");

export type Options =
  | {
      cacheDirectory: string | undefined;
      customFetch: (
        input: NodeFetch.RequestInfo,
        init?: NodeFetch.RequestInit | undefined
      ) => Promise<NodeFetch.Response>;
    }
  | null
  | undefined;

declare module "vfile" {
  interface DataMap {
    staticImages: {
      properties: (ESTreeJsx.Property | ESTreeJsx.SpreadElement)[];
      declarations: (ESTreeJsx.ImportDeclaration | undefined)[];
      sourceMap: Map<string, string>;
    };
  }
}

type ImageJsxFactory = ESTreeJsx.SimpleCallExpression & {
  callee: ESTreeJsx.Identifier;
  arguments: [
    component: ESTreeJsx.MemberExpression & {
      property: ESTreeJsx.Identifier & { name: "img" };
    },
    children: ESTreeJsx.ObjectExpression,
    ...rest: (ESTreeJsx.Expression | ESTreeJsx.SpreadElement)[]
  ];
};

type ImageData = {
  uuid: string;
  replacementSourcePropertyNode: ESTreeJsx.Property;
  fileExtension: string;
  importedAs: string;
  importedFrom: string | undefined;
  buffer: Buffer | undefined;
  importDeclaration: ESTreeJsx.ImportDeclaration | undefined;
};

const recmaStaticImages: Unified.Plugin<
  [(Options | undefined | void)?],
  ESTreeJsx.Program,
  ESTreeJsx.Program
> = function (this, options) {
  // deconstruct options (if provided) and set defaults where applicable
  const { cacheDirectory, customFetch: _fetch = node_fetch } = options ?? {};
  if (!cacheDirectory) throw new Error("cacheDirectory is required");
  let _cacheDirectory: string = cacheDirectory;
  if (!/^(\.\/)?public\/.*$/.test(cacheDirectory)) {
    console.warn(
      `cacheDirectory should be in the /public directory. Using public/${cacheDirectory} instead.}`
    );
    _cacheDirectory = `public/${cacheDirectory.replace(/^\.\//, "")}`;
  }
  // resolve the cache directory and remove trailing slashes; make sure it exists
  const cache = node_path.resolve(_cacheDirectory).replace(/\/+$/, "");

  if (!node_fs.existsSync(cache)) node_fs.mkdirSync(cache);

  const images = new Map<ESTreeJsx.Property & {
    key: ESTreeJsx.Identifier & { name: "src" };
    value: ESTreeJsx.SimpleLiteral & { value: string }
  }, ImageData
  >();

  return async function (tree, vfile) {
    if (!vfile.history[0])
      throw new Error(`File history is empty for ${vfile}`);

    vfile.path = vfile.history[0];
    vfile.dirname = node_path.dirname(vfile.path);
    vfile.info(
      `Processing ${vfile.path} with history: ${vfile.history.join(", ")}`
    );

    await visitAsync(
      tree,
      buildImageJsxFactoryTest(tree),
      async function (node) {
        const previousSourcePropertyNode = node.arguments[1].properties.find(
          (
            property
          ): property is ESTreeJsx.Property & {
            key: ESTreeJsx.Identifier & { name: "src" };
            value: ESTreeJsx.SimpleLiteral & { value: string };
          } =>
            property.type === "Property" &&
            property.key.type === "Identifier" &&
            property.key.name === "src" &&
            property.value.type === "Literal" &&
            typeof property.value.value === "string"
        );

        if (!previousSourcePropertyNode) return SKIP;

        if (!images.has(previousSourcePropertyNode)) {
          images.set(previousSourcePropertyNode, await (async () => {
            const id = uuid();
            const source = previousSourcePropertyNode.value.value;
            return {
              uuid: id,
              fileExtension: node_path
                .extname(source)
                .replace(/(\?|#).*$/, ""),
              importedAs: `__RecmaStaticImage${id}`,
              replacementSourcePropertyNode: {
                ...previousSourcePropertyNode,
                value: {
                  type: "Identifier",
                  name: `__RecmaStaticImage${id}`
                }
              },
              buffer: await (async () => {
              let url: URL | undefined;
              try {
                // will fail for relative paths
                url = new URL(source);
              } catch {
                // handle relative paths
                const _source = node_path.resolve(
                  assertAndReturn(vfile.dirname),
                  source
                );
                return async_node_fs.readFile(_source);
              }
              if (!url) return;
              return _fetch(url.href)
                .then((r) => {
                  if (r.status !== 200)
                    throw new Error(`Failed to fetch ${url?.href}`);
                  return r.arrayBuffer();
                })
                .then((r) => Buffer.from(r));
            })(),
            importedFrom: undefined,
            importDeclaration: undefined,
            }})());
        }

        images.set(previousSourcePropertyNode, await (async () => {
          const previous = assertAndReturn(images.get(previousSourcePropertyNode));
          const _buffer = assertAndReturn(previous.buffer);
          const _source = `${cache}/${sha256(_buffer)}${previous.fileExtension}`;
          await async_node_fs.writeFile(_source, _buffer);
          return {
            ...previous,
            importedFrom: _source,
            importDeclaration: {
              source: {
                type: "Literal",
                value: _source,
              },
              specifiers: [
                {
                  type: "ImportDefaultSpecifier",
                  local: {
                    name: assertAndReturn(previous.importedAs),
                    type: "Identifier",
                  },
                },
              ],
              type: "ImportDeclaration",
            }
          };
        })());

        node.arguments = [
          node.arguments[0],
          {
            ...node.arguments[1],
            properties: node.arguments[1].properties.map((property) => {
              if (images.has(property as typeof previousSourcePropertyNode)) {
                return assertAndReturn(images.get(property as typeof previousSourcePropertyNode))
                  .replacementSourcePropertyNode;
              }
              return property;
            })
          }
        ];

        return SKIP;
      }
    );

    await prependImportsToTree(
      tree,
      [...images.values()].map((image) => image.importDeclaration)
    );
  };
};
export default recmaStaticImages;

function assertAndReturn<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Unexpected null");
  return value;
}

function prependImportsToTree(
  tree: ESTreeJsx.Program,
  imports: (ESTreeJsx.ImportDeclaration | undefined)[]
) {
  return visitAsync(
    tree,
    (node): node is ESTreeJsx.Program => node.type === "Program",
    async function (node) {
      for (const declaration of imports) {
        if (declaration) node.body.unshift(declaration);
      }
    }
  );
}

function buildImageJsxFactoryTest(tree: ESTreeJsx.Program) {
  const names = new Set<string>();
  visit(tree, (node) => {
    if (
      node.type === "ImportSpecifier" &&
      "imported" in node &&
      /^jsxs?$/.test(node.imported.name)
    ) {
      names.add(node.local.name);
      return SKIP;
    }
    return CONTINUE;
  });
  return function (node: TreeWalker.Node): node is ImageJsxFactory {
    return (
      node.type === "CallExpression" &&
      "callee" in node &&
      node.callee.type === "Identifier" &&
      names.has(node.callee.name) &&
      node.arguments[0]?.type === "MemberExpression" &&
      node.arguments[0].property.type === "Identifier" &&
      node.arguments[0].property.name === "img" &&
      node.arguments[1]?.type === "ObjectExpression"
    );
  };
}

function sha256(data: node_crypto.BinaryLike) {
  return node_crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * No async visitor is provided, so we must make our own.
 * @see https://github.com/syntax-tree/unist-util-visit-parents/issues/8
 */
async function visitAsync<T extends TreeWalker.Node>(
  tree: ESTreeJsx.Program,
  test: (node: TreeWalker.Node) => node is T,
  asyncVisitor: (node: T) => Promise<ReturnType<TreeWalker.Visitor>>
) {
  const matches: T[] = [];
  visit(tree, (node) => {
    if (test(node)) matches.push(node);
  });
  const promises = matches.map((match) => asyncVisitor(match));
  await Promise.allSettled(promises);
  return;
}
