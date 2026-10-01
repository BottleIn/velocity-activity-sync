import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validatePortal } from '../portal/lib/snapshot.js';
import { loadPortalOutput } from './helpers/fixtures.js';
import { makePortal } from './helpers/portal-builder.js';

describe('validatePortal', () => {
  it('finds no problem in the synthetic fixture', () => {
    const output = loadPortalOutput();

    assert.deepEqual(validatePortal(output), []);
  });

  it('finds no problem in a small consistent portal', () => {
    const output = makePortal([{ foundId: '2001', approved: 1000 }, { foundId: '2002' }]);

    assert.deepEqual(validatePortal(output), []);
  });

  it('leaves the logged-in flag to the entry point', () => {
    const output = { ...makePortal([{ foundId: '2001' }]), loggedIn: false };

    assert.deepEqual(validatePortal(output), []);
  });

  it('reports a result that is not an object', () => {
    for (const output of [undefined, null, 5, 'x']) {
      const problems = validatePortal(output);

      assert.equal(problems.length, 1, String(output));
      assert.match(problems[0], /형식/);
    }
  });

  it('reports a missing activity table on the first list page', () => {
    const output = { ...makePortal([{ foundId: '2001' }]), listPages: [] };

    const problems = validatePortal(output);

    assert.equal(problems.length, 1);
    assert.match(problems[0], /목록 표/);
  });

  it('names the header columns that are missing', () => {
    const output = makePortal([{ foundId: '2001' }]);
    const table = output.listPages[0].tables[1];
    const header = table[0].cells.filter((cell) => cell !== '등록일');
    output.listPages[0].tables[1] = [{ cells: header, links: [] }, ...table.slice(1)];

    const problems = validatePortal(output);

    assert.equal(problems.length, 1);
    assert.match(problems[0], /등록일/);
  });

  it('reports a row count that differs from the total on the page', () => {
    const output = makePortal([{ foundId: '2001' }, { foundId: '2002' }]);
    output.listPages[0].text = output.listPages[0].text.replace('Total : 2', 'Total : 3');

    const problems = validatePortal(output);

    assert.equal(problems.length, 1);
    assert.match(problems[0], /2건/);
    assert.match(problems[0], /3건/);
  });

  it('reports an approved amount sum that differs from the total on the page', () => {
    const output = makePortal([{ foundId: '2001', approved: 1000 }, { foundId: '2002', approved: 2000 }]);
    output.listPages[0].text = output.listPages[0].text.replace('₩ 3,000', '₩ 9,999');

    const problems = validatePortal(output);

    assert.equal(problems.length, 1);
    assert.match(problems[0], /3,000원/);
    assert.match(problems[0], /9,999원/);
  });

  it('reports every failed check together', () => {
    const output = makePortal([{ foundId: '2001', approved: 1000 }]);
    output.listPages[0].text = 'Total : 5\n총 승인금액 ₩ 9,999 / $ 0';

    const problems = validatePortal(output);

    assert.equal(problems.length, 2);
  });

  it('reports totals that the page does not show', () => {
    const output = makePortal([{ foundId: '2001', approved: 1000 }]);
    output.listPages[0].text = '아무것도 없는 화면';

    const problems = validatePortal(output);

    assert.equal(problems.length, 2);
    assert.match(problems[0], /Total/);
    assert.match(problems[1], /총 승인금액/);
  });

  it('names the applications whose amounts could not be read', () => {
    const output = makePortal([{ foundId: '2001', approved: 1000 }, { foundId: '2002', approved: 500 }]);
    output.listPages[0].tables[1][2].cells[4] = '금액 없음';

    const problems = validatePortal(output);

    assert.equal(problems.length, 1);
    assert.match(problems[0], /2002/);
  });

  it('reports an application with no view page', () => {
    const output = makePortal([{ foundId: '2001' }, { foundId: '2002' }]);
    delete output.views['2002'];

    const problems = validatePortal(output);

    assert.equal(problems.length, 1);
    assert.match(problems[0], /2002/);
    assert.match(problems[0], /상세/);
  });

  it('reports an application with no evidence page', () => {
    const output = makePortal([{ foundId: '2001' }, { foundId: '2002' }]);
    delete output.evidences['2001'];

    const problems = validatePortal(output);

    assert.equal(problems.length, 1);
    assert.match(problems[0], /2001/);
    assert.match(problems[0], /증빙/);
  });

  it('tolerates a result without the views and evidences objects', () => {
    const output = { ...makePortal([{ foundId: '2001' }]), views: undefined, evidences: undefined };

    const problems = validatePortal(output);

    assert.equal(problems.length, 2);
  });
});
