/* eslint-disable unicorn/numeric-separators-style */
import node_fs from "node:fs";
import node_path from "node:path";
import node_fetch from "node-fetch";
import node_crypto from "node:crypto";
import { visit, SKIP, CONTINUE } from "estree-util-visit";

import type * as NodeFetch from "node-fetch";
import type * as Unified from "unified";
import type * as ESTreeJsx from "estree-jsx";
import type * as TreeWalker from "estree-util-visit";

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

const recmaStaticImages: Unified.Plugin<
  [(Options | undefined | void)?],
  ESTreeJsx.Program,
  ESTreeJsx.Program
> = function (options) {
  // deconstruct options (if provided) and set defaults where applicable
  const { cacheDirectory, customFetch: _fetch = node_fetch } = options ?? {};
  if (!cacheDirectory) throw new Error("cacheDirectory is required");

  // resolve the cache directory and remove trailing slashes; make sure it exists
  const cache = node_path.resolve(cacheDirectory).replace(/\/+$/, "");
  if (!node_fs.existsSync(cache)) node_fs.mkdirSync(cache);

  return async function (tree, vfile) {
    if (!vfile.history[0])
      throw new Error(`File history is empty for ${vfile}`);

    let imageCounter = 0;
    const sourceDirectory = vfile.history[0].replace(/[^/]*$/, "");
    const imports: (ESTreeJsx.ImportDeclaration | undefined)[] = [];
    const isImageJsxFactory = buildImageJsxFactoryTest(tree);

    await visitAsync(tree, isImageJsxFactory, async function (node) {
      const [argument0, argument1, ...rest] = node.arguments;
      const newProperties: (ESTreeJsx.Property | ESTreeJsx.SpreadElement)[] =
        [];

      for (const property of argument1.properties) {
        if (
          property.type !== "Property" ||
          property.key.type !== "Identifier" ||
          property.key.name !== "src" ||
          property.value.type !== "Literal" ||
          typeof property.value.value !== "string"
        ) {
          newProperties.push(property);
          continue;
        }

        imageCounter += 1;
        const value = property.value.value;
        let url: URL | undefined;
        let buffer: Buffer | undefined;

        try {
          // will fail for relative paths
          url = new URL(value);
        } catch {
          // handle relative paths
          const source = node_path.resolve(sourceDirectory, value);
          buffer = node_fs.readFileSync(source);
        }

        if (url) {
          const chunks = await _fetch(url.href).then((r) => {
            if (r.status !== 200)
              throw new Error(`Failed to fetch ${url?.href}`);
            return r.arrayBuffer();
          });
          buffer = Buffer.from(chunks);
        }

        if (!buffer)
          throw new Error(`Failed to read the file from ${url?.href}`);

        const extension = node_path.extname(value).replace(/(\?|#).*$/, "");
        const path = `${cache}/${sha256(buffer)}${extension}`;
        const declaration = generateImportDeclaration(path, imageCounter);

        imports.push(declaration);
        newProperties.push(buildSrcPropertyNode(imageCounter));
        node_fs.writeFile(path, buffer, (error) => {
          if (error) throw error;
        });
      }

      node.arguments = [
        argument0,
        { ...argument1, properties: newProperties },
        ...rest,
      ];
    });
    prependImportsToTree(tree, imports);
  };
};

export default recmaStaticImages;

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
  return function (
    node: TreeWalker.Node
  ): node is ESTreeJsx.SimpleCallExpression & {
    callee: ESTreeJsx.Identifier;
    arguments: [
      component: ESTreeJsx.MemberExpression & {
        property: ESTreeJsx.Identifier & { name: "img" };
      },
      children: ESTreeJsx.ObjectExpression,
      ...rest: (ESTreeJsx.Expression | ESTreeJsx.SpreadElement)[]
    ];
  } {
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

function generateImportDeclaration(
  path: string,
  index: number
): ESTreeJsx.ImportDeclaration {
  return {
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
  };
}

// eslint-disable-next-line unicorn/prevent-abbreviations
function buildSrcPropertyNode(index: number): ESTreeJsx.Property {
  return {
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
  };
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
  await Promise.all(promises);
  return;
}
