// @ts-check
/// <reference types="ses"/>
/* eslint no-underscore-dangle: ["off"] */

import 'ses';
import test from 'ava';
import { StaticModuleRecord } from '../src/static-module-record.js';

/** @typedef {import('ava').ExecutionContext} TestContext */

/**
 * @callback Updater
 * @param {any} value
 */
/** @typedef {Map<string, Map<string, Array<Updater>>>} ImportUpdaters */

/**
 * @param {TestContext} t
 * @param {StaticModuleRecord} record
 */
function assertDefaultExport(t, record) {
  t.deepEqual(record.imports, []);
  t.deepEqual(record.exports, ['default']);
  t.deepEqual(record.reexports, []);
  t.deepEqual(record.__fixedExportMap__, { default: ['default'] });
  t.deepEqual(record.__liveExportMap__, {});
}

test('export default', t => {
  t.plan(8);
  const record = new StaticModuleRecord('export default bb;');
  assertDefaultExport(t, record);

  const compartment = new Compartment({
    bb: 'bingbang',
  });
  const functor = compartment.evaluate(record.__syncModuleProgram__);
  t.is(typeof functor, 'function');

  functor({
    imports: () => {
      t.assert(true);
    },
    onceVar: {
      /** @type {(value: string) => void} */
      default: bb => {
        t.is(bb, 'bingbang');
      },
    },
  });
});

/**
 * @param {TestContext} t
 * @param {string} source
 * @param {Object} [options]
 * @param {Object} [options.endowments]
 * @param {Map<string, Map<string, any>>} [options.imports]
 */
function initialize(t, source, options = {}) {
  const { endowments, imports = new Map() } = options;
  const record = new StaticModuleRecord(source);
  const liveUpdaters = {};
  const onceUpdaters = {};
  const namespace = {};
  const log = [];
  Object.keys(record.__liveExportMap__).forEach(name => {
    /** @param {any} value */
    liveUpdaters[name] = value => {
      namespace[name] = value;
      log.push(`${name}: ${JSON.stringify(value)}`);
    };
  });
  Object.keys(record.__fixedExportMap__).forEach(name => {
    /** @param {any} value */
    onceUpdaters[name] = value => {
      t.assert(!(name in namespace));
      namespace[name] = value;
      log.push(`${name}: ${JSON.stringify(value)}`);
    };
  });
  const compartment = new Compartment(endowments);
  const functor = compartment.evaluate(record.__syncModuleProgram__);

  /** @type {Map<string, Map<string, Updater>>} */
  const updaters = new Map();

  /**
   * @param {ImportUpdaters} newUpdaters
   */
  function updateImports(newUpdaters) {
    for (const [module, moduleUpdaters] of Array.from(newUpdaters.entries())) {
      const moduleImports = imports.get(module);
      const testUpdaters = new Map();
      updaters.set(module, testUpdaters);
      if (moduleImports) {
        for (const [importName, importUpdaters] of Array.from(
          moduleUpdaters.entries(),
        )) {
          /** @param {any} value */
          const updateImport = value => {
            for (const importUpdater of importUpdaters) {
              importUpdater(value);
            }
          };
          testUpdaters.set(importName, updateImport);
          if (moduleImports.has(importName)) {
            updateImport(moduleImports.get(importName));
          }
        }
      }
    }
  }

  functor({
    imports: updateImports,
    liveVar: liveUpdaters,
    onceVar: onceUpdaters,
  });

  return { record, namespace, log, updaters };
}

test('export default anonymous class', t => {
  const { record, namespace } = initialize(
    t,
    `\
export default class {
  valueOf() {
    return 45;
  }
}
`,
  );
  assertDefaultExport(t, record);
  /**
   * @typedef {Object} Class
   * @property {() => number} valueOf
   */
  const Class = /** @type {new () => Class} */ namespace.default;
  const instance = new Class();
  t.is(instance.valueOf(), 45);
});

test('export default and handle shebang', t => {
  const { record, namespace } = initialize(
    t,
    `\
#! /usr/bin/env node
export default 123
`,
  );
  assertDefaultExport(t, record);
  t.is(namespace.default, 123);
});

test('export default arguments (not technically valid but must be handled)', t => {
  const { record, namespace } = initialize(t, `export default arguments`);
  assertDefaultExport(t, record);
  t.is(typeof namespace.default, 'object');
  t.is(namespace.default[0], record.__syncModuleProgram__);
  t.is(namespace.default.length, 1);
});

test.failing('export default this', t => {
  const { record, namespace } = initialize(t, `export default this`, {
    endowments: { leak: 'leaks' },
  });
  assertDefaultExport(t, record);
  t.is(namespace.default, undefined);
});

test.failing('export named', t => {
  const { log } = initialize(
    t,
    `\
export let abc = 123;
export let def = 456;
export let def2 = def;
def ++;
def += 1;
def = 789;
export const ghi = 'abc';
`,
  );

  t.deepEqual(log, [
    'abc: 123',
    'def: 456',
    'def2: 456',
    'def: 457', // update
    'def: 789',
    'ghi: abc',
  ]);
});

test('export destructure', t => {
  const { record, namespace } = initialize(
    t,
    `\
    export const abc = 123;
    export const { def, nest: [, ghi, ...nestrest], ...rest } = {
      def: 456,
      nest: ['skip', 789, 'a', 'b'],
      other: 999,
      and: 998
    };
`,
  );
  t.deepEqual(record.imports, []);
  t.deepEqual(
    [...record.exports].sort(),
    ['abc', 'def', 'ghi', 'nestrest', 'rest'].sort(),
  );
  t.deepEqual(record.reexports, []);
  // abc and def2 are declared as 'let' but de-facto fixed since there are no
  // subsequent updates.
  t.deepEqual(record.__fixedExportMap__, {
    abc: ['abc'],
    def: ['def'],
    ghi: ['ghi'],
    nestrest: ['nestrest'],
    rest: ['rest'],
  });
  t.deepEqual(record.__liveExportMap__, {});

  t.deepEqual(namespace, {
    abc: 123,
    def: 456,
    ghi: 789,
    nestrest: ['a', 'b'],
    rest: { other: 999, and: 998 },
  });
});

test('const exports without hoisting', t => {
  t.throws(
    () =>
      initialize(
        t,
        `\
const abc2 = abc;
export const abc = 123;
`,
      ),
    {
      instanceOf: ReferenceError,
      message: "Cannot access 'abc' before initialization",
    },
  );
});

test('let exports without hoisting', t => {
  t.throws(
    () =>
      initialize(
        t,
        `\
const abc2 = abc;
export let abc = 123;
`,
      ),
    {
      instanceOf: ReferenceError,
      message: `Cannot access 'abc' before initialization`,
    },
  );
});

test.failing('var exports with hoisting', t => {
  const { log } = initialize(
    t,
    `\
export const abc2 = abc;
export var abc = 123;
export const abc3 = abc;
`,
  );
  t.deepEqual(log, ['abc2: undefined', 'abc: 123', 'abc3: 123']);
});

test.failing('function exports with hoisting', t => {
  const { namespace } = initialize(
    t,
    `\
export const fn2 = fn;
export function fn() {
  return 'foo';
}
export const fn3 = fn;
`,
  );
  const { fn, fn2, fn3 } = namespace;
  t.is(fn2, fn, 'function hoisting');
  t.is(fn, fn3, 'function exports with hoisting');
  t.is(fn(), 'foo', 'fn evaluates');
});

test.failing('export class and let', t => {
  const { namespace } = initialize(
    t,
    `\
export let count = 0;
export class C {} if (C) { count += 1; }
`,
  );
  const { C, count } = namespace;
  t.truthy(new C(), 'class exports');
  t.is(C.name, 'C', 'class is named C');
  t.is(count, 1, 'class C is global');
});

test('export default named class', t => {
  const { namespace } = initialize(
    t,
    `\
export default class C {}
`,
  );
  const { default: C } = namespace;
  t.truthy(new C(), 'default class constructs');
  t.is(C.name, 'C', 'C class name');
});

test('export named class', t => {
  const { namespace } = initialize(
    t,
    `\
export class C {}
`,
  );
  const { C } = namespace;
  t.truthy(new C(), 'default class constructs');
  t.is(C.name, 'C', 'C class name');
});

test('export default class expression', t => {
  const { namespace } = initialize(
    t,
    `\
export default (class {});
`,
  );
  const { default: C } = namespace;
  t.truthy(new C(), 'default class constructs');
  t.is(C.name, 'default', 'C class name');
});

test.failing('hoist export function', t => {
  const { namespace } = initialize(
    t,
    `\
F(123);
export function F(arg) { return arg; }
`,
  );
  const { F } = namespace;
  t.is(F.name, 'F', 'F function name');
});

test.failing('hoist default async export named function', async t => {
  const { namespace } = initialize(
    t,
    `\
F(123);
export default async function F(arg) { return arg; }
`,
  );
  const { F } = namespace;
  t.is(F.name, 'F', 'F function name');
  const ret = F('foo');
  t.truthy(ret instanceof Promise, 'F is async');
  t.is(await ret, 'foo', 'F returns correctly');
});

test.failing('hoist default async export anonymous function', async t => {
  const { namespace } = initialize(
    t,
    `\
F(123);
export default async function (arg) { return arg; }
`,
  );
  const { F } = namespace;
  t.is(F.name, 'default', 'default function name');
  const ret = F('foo');
  t.truthy(ret instanceof Promise, 'F is async');
  t.is(await ret, 'foo', 'F returns correctly');
});

test('zero width joiner is reserved', t => {
  t.throws(() => {
    const _ = new StaticModuleRecord(
      `const $h\u200d_import = 123; $h\u200d_import`,
    );
  });
});

test('zero width joiner in constified variable is reserved', t => {
  t.throws(() => {
    const _ = new StaticModuleRecord(
      `const $c\u200d_myVar = 123; $c\u200d_myVar`,
    );
  });
});

test('zero width joiner is allowed in non-reserved words', t => {
  const { namespace } = initialize(
    t,
    `const $h\u200d_import2 = 123; export default $h\u200d_import2`,
  );
  const { default: name } = namespace;
  t.is(name, 123);
});

test('private member syntax works', t => {
  const { namespace } = initialize(
    t,
    `\
class outer {
  #x = 42;
  f() {
    return this.#x;
  }
}
export default new outer().f();
`,
  );
  t.is(namespace.default, 42);
});

test('nested export fails as syntax', t => {
  t.throws(() => new StaticModuleRecord(`{ void 0; export default null; }`), {
    instanceOf: SyntaxError,
  });
});

test('import * as name', t => {
  const module = {};

  const { namespace } = initialize(
    t,
    `\
import * as ns from 'module';
export default ns;
`,
    {
      imports: new Map([['module', new Map([['*', module]])]]),
    },
  );

  t.is(namespace.default, module);
});

test('import names', t => {
  const { namespace } = initialize(
    t,
    `\
import { foo, bar } from 'module';
export const foobar = foo + bar;
`,
    {
      imports: new Map([
        [
          'module',
          new Map([
            ['foo', 10],
            ['bar', 20],
          ]),
        ],
      ]),
    },
  );

  t.is(namespace.foobar, 30);
});

test('import name', t => {
  const { namespace } = initialize(
    t,
    `
import name from 'module';
export default name;
`,
    {
      imports: new Map([['module', new Map([['default', 'xyz']])]]),
    },
  );
  t.is(namespace.default, 'xyz');
});

test('import default and names', t => {
  const { namespace } = initialize(
    t,
    `
import name, { exported as imported } from 'module';
export default [name, imported];
`,
    {
      imports: new Map([
        [
          'module',
          new Map([
            ['default', 'apples'],
            ['exported', 'oranges'],
          ]),
        ],
      ]),
    },
  );
  t.deepEqual(namespace.default, ['apples', 'oranges']);
});

test('import for side-effect', t => {
  const { record } = initialize(t, `import 'module'`);
  t.deepEqual(record.__fixedExportMap__, {});
  t.deepEqual(record.__liveExportMap__, {});
  t.deepEqual(record.imports, ['module']);
});
