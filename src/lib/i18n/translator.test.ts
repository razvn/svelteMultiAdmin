import { describe, expect, it } from 'vitest';
import { interpolate, paramNames } from './interpolate.ts';
import { Translator, contextKey, mergeCatalogs } from './translator.ts';

describe('interpolate', () => {
	it('replaces {name} params and leaves unknown ones', () => {
		expect(interpolate('Hello {name}, {n} new', { name: 'Ada', n: 3 })).toBe('Hello Ada, 3 new');
		expect(interpolate('Hello {name}', {})).toBe('Hello {name}');
		expect(interpolate('{a} {a}', { a: 'x' })).toBe('x x');
		expect(interpolate('plain {"json": 1}')).toBe('plain {"json": 1}');
	});
	it('lists params', () => {
		expect(paramNames('{b} and {a} and {b}')).toEqual(['a', 'b']);
	});
});

describe('Translator.t', () => {
	const fr = new Translator('fr', {
		Databases: 'Bases de données',
		Hello: 'Bonjour {name}',
		Empty: ''
	});
	it('translates, interpolates and falls back to English', () => {
		expect(fr.t('Databases')).toBe('Bases de données');
		expect(fr.t('Hello', { name: 'Ada' })).toBe('Bonjour Ada');
		expect(fr.t('Unknown {x}', { x: 1 })).toBe('Unknown 1');
		expect(fr.t('Empty')).toBe('Empty');
	});
	it('does not read inherited properties as translations', () => {
		expect(fr.t('constructor')).toBe('constructor');
		expect(fr.t('toString')).toBe('toString');
	});
	it('can be destructured', () => {
		const { t } = fr;
		expect(t('Databases')).toBe('Bases de données');
	});
});

describe('Translator.tc', () => {
	const fr = new Translator('fr', {
		[contextKey('verb', 'Export')]: 'Exporter',
		[contextKey('noun', 'Export')]: 'Exportation'
	});
	it('picks the translation of the context, falls back to the msgid', () => {
		expect(fr.tc('verb', 'Export')).toBe('Exporter');
		expect(fr.tc('noun', 'Export')).toBe('Exportation');
		expect(fr.tc('other', 'Export')).toBe('Export');
	});
});

describe('Translator.tn', () => {
	const en = new Translator('en');
	it('English source: singular for 1, plural otherwise, {n} available', () => {
		expect(en.tn('{n} row', '{n} rows', 1)).toBe('1 row');
		expect(en.tn('{n} row', '{n} rows', 0)).toBe('0 rows');
		expect(en.tn('{n} row', '{n} rows', 5)).toBe('5 rows');
		expect(en.tn('{n} row of {t}', '{n} rows of {t}', 2, { t: 'x' })).toBe('2 rows of x');
	});
	it('French: 0 and 1 are singular', () => {
		const fr = new Translator('fr', {
			'{n} row': ['{n} ligne', '{n} millions de lignes', '{n} lignes']
		});
		expect(fr.tn('{n} row', '{n} rows', 0)).toBe('0 ligne');
		expect(fr.tn('{n} row', '{n} rows', 1)).toBe('1 ligne');
		expect(fr.tn('{n} row', '{n} rows', 2)).toBe('2 lignes');
		expect(fr.tn('{n} row', '{n} rows', 1_000_000)).toBe('1000000 millions de lignes');
	});
	it('Spanish: 1 is singular, 0 and 2 plural', () => {
		const es = new Translator('es', { '{n} row': ['{n} fila', '{n} filas', '{n} filas'] });
		expect(es.tn('{n} row', '{n} rows', 1)).toBe('1 fila');
		expect(es.tn('{n} row', '{n} rows', 0)).toBe('0 filas');
		expect(es.tn('{n} row', '{n} rows', 2)).toBe('2 filas');
	});
	it('French has one/many/other forms', () => {
		const fr = new Translator('fr', {
			'{n} key': ['{n} clé', '{n} de clés', '{n} clés']
		});
		expect(fr.tn('{n} key', '{n} keys', 0)).toBe('0 clé'); // fr: 0 and 1 are "one"
		expect(fr.tn('{n} key', '{n} keys', 1)).toBe('1 clé');
		expect(fr.tn('{n} key', '{n} keys', 1000000)).toBe('1000000 de clés'); // fr: "many"
		expect(fr.tn('{n} key', '{n} keys', 2)).toBe('2 clés');
	});
	it('falls back to English when the translation is empty or missing', () => {
		const fr = new Translator('fr', { '{n} row': ['', '', ''] });
		expect(fr.tn('{n} row', '{n} rows', 3)).toBe('3 rows');
		expect(fr.tn('{n} file', '{n} files', 1)).toBe('1 file');
	});
});

describe('mergeCatalogs', () => {
	it('merges area catalogs, later wins', () => {
		expect(mergeCatalogs([{ a: '1', b: '2' }, { b: '3' }])).toEqual({ a: '1', b: '3' });
	});
});
