import { sha256 } from ".";
import node_fs from "node:fs";
import node_path from "node:path";
import { test, expect } from 'vitest'

test('hash returns string for local file', () => {
	const filename = '__test__/img/spongebob.jpg'
	const source = node_path.resolve(__dirname, filename);
	const buffer = node_fs.readFileSync(source);
	const result = sha256(buffer);
	expect(typeof result).toBe('string')
})

export { }
