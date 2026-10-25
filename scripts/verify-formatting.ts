/*---------------------------------------------------------------------------------------------
 * Formatting verifier, adapted from vscode's build/lib/formatter.ts
 * (https://github.com/microsoft/vscode, MIT License).
 *
 * Replays the exact formatting that VS Code's built-in TypeScript formatter
 * applies (defaults + tsfmt.json overrides) via the TypeScript compiler API,
 * then checks that each file already matches that output.
 *
 * Usage:
 *   node scripts/verify-formatting.ts --verify  [files...]   # check (default)
 *   node scripts/verify-formatting.ts --replace [files...]   # rewrite files
 *   node scripts/verify-formatting.ts                        # check all tracked *.ts
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs';
import cp from 'child_process';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import ts from 'typescript';

class LanguageServiceHost implements ts.LanguageServiceHost {
	files: ts.MapLike<ts.IScriptSnapshot> = {};
	addFile(fileName: string, text: string) {
		this.files[fileName] = ts.ScriptSnapshot.fromString(text);
	}

	fileExists(path: string): boolean {
		return !!this.files[path];
	}

	readFile(path: string): string | undefined {
		return this.files[path]?.getText(0, this.files[path]!.getLength());
	}

	// for ts.LanguageServiceHost

	getCompilationSettings = () => ts.getDefaultCompilerOptions();
	getScriptFileNames = () => Object.keys(this.files);
	getScriptVersion = (_fileName: string) => '0';
	getScriptSnapshot = (fileName: string) => this.files[fileName];
	getCurrentDirectory = () => process.cwd();
	getDefaultLibFileName = (options: ts.CompilerOptions) => ts.getDefaultLibFilePath(options);
}

const defaults: ts.FormatCodeSettings = {
	baseIndentSize: 0,
	indentSize: 4,
	tabSize: 4,
	indentStyle: ts.IndentStyle.Smart,
	newLineCharacter: '\n',
	convertTabsToSpaces: false,
	insertSpaceAfterCommaDelimiter: true,
	insertSpaceAfterSemicolonInForStatements: true,
	insertSpaceBeforeAndAfterBinaryOperators: true,
	insertSpaceAfterConstructor: false,
	insertSpaceAfterKeywordsInControlFlowStatements: true,
	insertSpaceAfterFunctionKeywordForAnonymousFunctions: false,
	insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis: false,
	insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets: false,
	insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true,
	insertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces: false,
	insertSpaceAfterOpeningAndBeforeClosingJsxExpressionBraces: false,
	insertSpaceAfterTypeAssertion: false,
	insertSpaceBeforeFunctionParenthesis: false,
	placeOpenBraceOnNewLineForFunctions: false,
	placeOpenBraceOnNewLineForControlBlocks: false,
	insertSpaceBeforeTypeAnnotation: false,
};

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const getOverrides = (() => {
	const tsfmtPath = path.join(projectRoot, 'tsfmt.json');
	const cache = new Map<string, ts.FormatCodeSettings>();
	return (_fileName: string) => {
		if (!cache.has(tsfmtPath)) {
			cache.set(tsfmtPath, JSON.parse(fs.readFileSync(tsfmtPath, 'utf8')));
		}
		return cache.get(tsfmtPath)!;
	};
})();

export function format(fileName: string, text: string) {
	// Preserve the file's existing line endings; the TS formatter only inserts
	// new lines using `newLineCharacter`.
	const newLineCharacter = text.includes('\r\n') ? '\r\n' : '\n';

	const host = new LanguageServiceHost();
	host.addFile(fileName, text);

	const languageService = ts.createLanguageService(host);
	const edits = languageService.getFormattingEditsForDocument(fileName, {
		...defaults,
		newLineCharacter,
		...getOverrides(fileName),
	});
	edits
		.sort((a, b) => a.span.start - b.span.start)
		.reverse()
		.forEach(edit => {
			const head = text.slice(0, edit.span.start);
			const tail = text.slice(edit.span.start + edit.span.length);
			text = `${head}${edit.newText}${tail}`;
		});

	return text;
}

export function verifyFormatting(fileName: string, text: string): boolean {
	const formatted = format(fileName, text);
	return text.replace(/\r\n/gm, '\n') === formatted.replace(/\r\n/gm, '\n');
}

function listTrackedTypeScriptFiles(): string[] {
	const out = cp.execSync('git ls-files "*.ts"', {
		cwd: projectRoot,
		encoding: 'utf8',
		maxBuffer: 10 * 1024 * 1024,
	});
	return out.split(/\r?\n/).filter((line: string) => !!line);
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
	const args = process.argv.slice(2);
	const verify = args.includes('--verify');
	const replace = args.includes('--replace');
	const explicitFiles = args.filter(arg => !arg.startsWith('--'));
	const files = explicitFiles.length > 0
		? explicitFiles.map(f => path.resolve(f))
		: listTrackedTypeScriptFiles().map(f => path.resolve(projectRoot, f));

	let errorCount = 0;
	for (const file of files) {
		const text = fs.readFileSync(file, 'utf8');
		if (replace) {
			const formatted = format(file, text);
			if (text !== formatted) {
				fs.writeFileSync(file, formatted);
				console.log(`Formatted: ${path.relative(projectRoot, file)}`);
			}
		} else if (!verifyFormatting(file, text)) {
			console.error(
				`File not formatted. Run the 'Format Document' command or 'npm run format' to fix it:`,
				path.relative(projectRoot, file)
			);
			errorCount++;
		}
	}

	if (errorCount > 0) {
		process.exit(1);
	}
	console.log(replace ? 'Formatting complete.' : `All ${files.length} file(s) properly formatted.`);
}
