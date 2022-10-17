/* eslint-disable unicorn/numeric-separators-style */
import type { Plugin } from "unified";
import type {
  Program,
  ImportDeclaration,
  Property,
  SpreadElement,
} from "estree-jsx";

import { visit, SKIP, CONTINUE, type Node, Visitor } from "estree-util-visit";
import fs from "node:fs";
import nodePath from "node:path";
import { URL } from "node:url";
import crypto from "node:crypto";
import nodeFetch, {
  Response,
  type RequestInfo,
  type RequestInit,
} from "node-fetch";
import type {
  SimpleCallExpression,
  Identifier,
  MemberExpression,
  ObjectExpression,
} from "estree";

export type Options =
  | {
      cacheDirectory: string | undefined;
      fetcher: (
        input: RequestInfo,
        init?: RequestInit | undefined
      ) => Promise<Response>;
    }
  | null
  | undefined;

const recmaStaticImages: Plugin<
  [(Options | undefined | void)?],
  Program,
  Program
> = function (options) {
  /*
   * Extract config properties from the options object or, if nullish, an empty object.
   * If a propperty is undefined on the right, it may be set to its default value on the left.
   */
  const { cacheDirectory, fetcher: _fetch = nodeFetch } = options ?? {};
  if (!cacheDirectory) throw new Error("cacheDirectory is required");

  const cache = nodePath.resolve(cacheDirectory).replace(/\/+$/, "");
  if (!fs.existsSync(cache)) fs.mkdirSync(cache);

  return async function (tree, vfile) {
    if (!vfile.history[0])
      throw new Error(`File history is empty for ${vfile}`);

    let imageCounter = 0;
    const jsxFactorySpecifiers = getJsxFactorySpecifiers(tree);
    const sourceDirectory = vfile.history[0].replace(/[^/]*$/, "");
    const imports: (ImportDeclaration | undefined)[] = [];
    type ValidJsxImageConstructor = SimpleCallExpression & {
      callee: Identifier;
      arguments: [
        component: MemberExpression & { property: Identifier & { name: "img" } },
        children: ObjectExpression,
        ...rest: unknown[]
      ];
    };

    await visitAsync(
      tree,
      (node: Node): node is ValidJsxImageConstructor =>
        (node.type === "CallExpression" &&
          "callee" in node &&
          node.callee.type === "Identifier" &&
          jsxFactorySpecifiers.has(node.callee.name) &&
          node.arguments[0] &&
          node.arguments[0].type === "MemberExpression" &&
          node.arguments[0].property.type === "Identifier" &&
          node.arguments[0].property.name === "img" &&
          node.arguments[1] &&
          node.arguments[1].type === "ObjectExpression") ||
        false,
      async function (node: ValidJsxImageConstructor) {
        const [argument0, argument1, ...rest] = node.arguments;
        const newProperties: (Property | SpreadElement)[] = [];

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
          const extension = getExtension(value);
          let url: URL | undefined;
          let buffer: Buffer | string | undefined;
          let path: string | undefined;

          try {
            // will fail for relative paths
            url = new URL(value);
          } catch {
            // handle relative paths
            const source = nodePath.resolve(sourceDirectory, value);
            buffer = fs.readFileSync(source);
            path = `${cache}/${sha256(buffer)}${extension}`;
          }

          if (url instanceof URL) {
            // handle absolute URLs
            buffer = await _fetch(url.href).then((r) => {
              if (!r?.body) throw new Error(`Failed to fetch ${url?.href}`);
              return r.body.read();
            });
            path = `${cache}/${sha256(url.href)}${extension}`;
          }

          if (!path) throw new Error(`Missing path for image: ${value}`);
          assertBuffer(buffer);
          fs.writeFileSync(path, buffer);
          const declaration = generateImportDeclaration(path, imageCounter);
          imports.push(declaration);
          newProperties.push(generateSrcPropertyNode(imageCounter));
        }

        node.arguments = [
          argument0,
          { ...argument1, properties: newProperties },
          ...rest,
        ];
      }
    );

    await visitAsync(
      tree,
      (node): node is Program => node.type === "Program",
      async function (node) {
        for (const declaration of imports) {
          if (declaration) node.body.unshift(declaration);
        }
      }
    );
  };
};

export default recmaStaticImages;

/**
 * Find the local identifier assigned to the imported JSX factory(s)
 * @example: `import theFactory from 'jsx'
 */
 function getJsxFactorySpecifiers(tree: Program) {
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
  return names;
}

function sha256(data: crypto.BinaryLike) {
  return crypto.createHash("sha256").update(data).digest("base64");
}

function getExtension(path: string) {
  const name = path.split('/').at(-1);
  const split = name?.split(".") ?? [];
  if (split.length < 2) return "";
  return `.${split.at(-1)}`;
}

function assertBuffer(
  buffer: Buffer | string | undefined
): asserts buffer is Buffer {
  if (buffer instanceof Buffer) return;
  throw new Error(`Expected buffer, got ${buffer}`);
}

function generateImportDeclaration(
  path: string,
  index: number
): ImportDeclaration {
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
function generateSrcPropertyNode(index: number): Property {
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

async function visitAsync<T extends Node>(
  tree: Program,
  test: (node: Node) => node is T,
  asyncVisitor: (node: T) => Promise<ReturnType<Visitor>>
) {
  const matches: T[] = [];
  visit(tree, (node) => {
    if (test(node)) matches.push(node);
  });
  const promises = matches.map((match) => asyncVisitor(match));
  await Promise.all(promises);
  return;
}
