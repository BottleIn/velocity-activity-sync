import { FILE_REASON, isKnown } from './amounts.js';
import { fileLabel, parseEvidenceLinks } from './evidence.js';
import { formatRawValues, formatWon } from './format.js';
import { parseListPages } from './list.js';
import { parseViewText } from './view.js';

// 증빙완료인 신청만 결제로 센다. 증빙이 끝나야 돈이 나간 것으로 보는 규칙이다.
export const EVIDENCE_COMPLETED = '증빙완료';

export const KIND = Object.freeze({ NONE: 'none', ONCE: 'once', MONTHLY: 'monthly' });

export const WARNING = Object.freeze({
  BROWSER_ERROR: 'browser_error',
  VIEW_UNPARSED: 'view_unparsed',
  VIEW_MISMATCH: 'view_mismatch',
  NO_ITEMS: 'no_items',
  FILES_BEFORE_COMPLETION: 'files_before_completion',
  COMPLETED_WITHOUT_FILES: 'completed_without_files',
  FILE_WITHOUT_MONTH: 'file_without_month',
  ROUND_UNMAPPED: 'round_unmapped',
  FILE_NOT_READ: 'file_not_read',
  FILE_UNREADABLE: 'file_unreadable',
  NO_LABELED_FILE: 'no_labeled_file',
  DUPLICATE_STATEMENT: 'duplicate_statement',
  NOT_KRW: 'not_krw',
});

const ROUND_SUFFIX = '차';
const LABELED_REASONS = new Set([FILE_REASON.OK, FILE_REASON.NOT_KRW]);
const MONTH_SLICE = [5, 7];

function hasPage(pages, foundId) {
  const isObject = (value) => value !== null && typeof value === 'object';
  return isObject(pages) && Object.hasOwn(pages, foundId) && isObject(pages[foundId]);
}

function listProblems({ head, rows, headerFound, missingColumns }) {
  if (!headerFound) {
    return ['활동비 목록 표를 찾지 못했습니다. 포털 화면이 바뀌었거나 목록이 아닌 화면을 읽었을 수 있습니다.'];
  }
  if (missingColumns.length > 0) {
    return [`활동비 목록 표에 필요한 칸이 없습니다: ${missingColumns.join(', ')}. 포털 화면이 바뀌었을 수 있습니다.`];
  }
  return [...countProblems(head, rows), ...amountProblems(head, rows)];
}

function countProblems(head, rows) {
  if (head.total === null) return ['화면의 Total(전체 건수)을 읽지 못했습니다.'];
  if (rows.length === head.total) return [];
  return [`목록에서 읽은 신청은 ${rows.length}건인데 화면의 Total은 ${head.total}건입니다.`];
}

function amountProblems(head, rows) {
  const unreadable = rows.filter((row) => row.requested.krw === null || row.approved.krw === null);
  if (unreadable.length > 0) {
    return [`신청금액이나 승인금액을 읽지 못한 신청이 있습니다: ${unreadable.map((row) => row.foundId).join(', ')}`];
  }
  if (head.approvedKrw === null) return ['화면의 총 승인금액을 읽지 못했습니다.'];
  const sum = rows.reduce((total, row) => total + row.approved.krw, 0);
  if (sum === head.approvedKrw) return [];
  return [`목록의 승인금액 합계는 ${formatWon(sum)}인데 화면의 총 승인금액은 ${formatWon(head.approvedKrw)}입니다.`];
}

function pageProblems(foundId, output) {
  return [
    ...(hasPage(output.views, foundId) ? [] : [`신청 ${foundId}의 상세 화면을 읽지 못했습니다.`]),
    ...(hasPage(output.evidences, foundId) ? [] : [`신청 ${foundId}의 증빙 화면을 읽지 못했습니다.`]),
  ];
}

export function validatePortal(output) {
  if (output === null || typeof output !== 'object') return ['포털 읽기 결과의 형식이 올바르지 않습니다.'];
  const list = parseListPages(output.listPages);
  return [...listProblems(list), ...list.rows.flatMap((row) => pageProblems(row.foundId, output))];
}

function warn(code, foundId, message, key = null) {
  return key === null ? { code, foundId, message } : { code, foundId, key, message };
}

function fileNames(files) {
  return files.map(fileLabel).join(', ');
}

function classify(row, files) {
  if (row.requested.krw === 0 && row.approved.krw === 0) return KIND.NONE;
  return files.some((file) => file.month !== null) ? KIND.MONTHLY : KIND.ONCE;
}

function roundOf(month, monthToRound) {
  return month !== null && Object.hasOwn(monthToRound, month) ? monthToRound[month] : null;
}

function monthOfDate(date) {
  return date === null ? null : Number(date.slice(...MONTH_SLICE));
}

function resultOf(fileResults, key) {
  const result = Object.hasOwn(fileResults, key) ? fileResults[key] : undefined;
  return result !== null && typeof result === 'object' ? result : undefined;
}

function unknownGroup(problem) {
  return { krw: null, rawValues: problem.rawValues ?? [], problem };
}

function evaluateLabeled({ file, result }) {
  if (result.reason === FILE_REASON.OK && isKnown(result.total)) {
    return { krw: result.total, rawValues: [], problem: null };
  }
  const amounts = Array.isArray(result.amounts) ? result.amounts : [];
  const rawValues = amounts.filter((amount) => amount.krw === null).map((amount) => String(amount.raw ?? ''));
  return unknownGroup({ code: WARNING.NOT_KRW, files: [file], rawValues });
}

// 아직 읽지 못한 파일과 읽는 데 실패한 파일이 하나라도 있으면 나머지만으로 합계를 내지 않는다.
// 볼 수 없는 파일이 다른 결제자의 내역서일 수 있고, 그러면 합계가 실제보다 작게 나온다.
// 라벨이 없는 파일(no_label)과 지원하지 않는 형식(unsupported)은 따로 올린 영수증이나 이미지라서 무시한다.
// 라벨 있는 파일이 둘 이상이면 같은 내역서가 겹쳐 올라온 것일 수 있어 합치지 않고 모름으로 둔다.
function evaluateGroup(files, fileResults) {
  if (files.length === 0) return unknownGroup({ code: WARNING.COMPLETED_WITHOUT_FILES, files });
  const entries = files.map((file) => ({ file, result: resultOf(fileResults, file.key) }));
  const unavailable = entries.filter(({ result }) => result === undefined || result.reason === FILE_REASON.UNREADABLE);
  if (unavailable.length > 0) {
    const isUnseen = unavailable.some(({ result }) => result === undefined);
    return unknownGroup({
      code: isUnseen ? WARNING.FILE_NOT_READ : WARNING.FILE_UNREADABLE,
      files: unavailable.map(({ file }) => file),
    });
  }
  const labeled = entries.filter(({ result }) => LABELED_REASONS.has(result.reason));
  if (labeled.length === 0) return unknownGroup({ code: WARNING.NO_LABELED_FILE, files });
  if (labeled.length > 1) {
    return unknownGroup({ code: WARNING.DUPLICATE_STATEMENT, files: labeled.map(({ file }) => file) });
  }
  return evaluateLabeled(labeled[0]);
}

function problemMessage({ code, files, rawValues }, label) {
  const names = fileNames(files);
  switch (code) {
    case WARNING.COMPLETED_WITHOUT_FILES:
      return `${label}: 증빙완료인데 증빙 파일이 없어 결제 금액을 알 수 없습니다.`;
    case WARNING.FILE_NOT_READ:
      return `${label}: 아직 읽지 못한 증빙 파일이 있어 결제 금액을 알 수 없습니다 (파일: ${names}). 다시 실행하면 다시 시도합니다.`;
    case WARNING.FILE_UNREADABLE:
      return `${label}: 증빙 파일을 읽지 못해 결제 금액을 알 수 없습니다 (파일: ${names}). 다시 실행하면 다시 시도합니다.`;
    case WARNING.NO_LABELED_FILE:
      return `${label}: '금액(VAT포함)' 칸이 있는 증빙 파일이 없어 결제 금액을 알 수 없습니다 (파일: ${names}).`;
    case WARNING.DUPLICATE_STATEMENT:
      return `${label}: '금액(VAT포함)' 칸이 있는 증빙 파일이 ${files.length}개라 같은 내역서가 겹쳤을 수 있어 결제 금액을 정하지 않았습니다 (파일: ${names}).`;
    default:
      return `${label}: 원화 금액으로 읽지 못한 값이 있어 결제 금액을 알 수 없습니다 (읽은 값: ${formatRawValues(rawValues)}, 파일: ${names}).`;
  }
}

function roundMessage(label, month) {
  return month === null
    ? `${label}: 신청일을 읽지 못해 차수를 정하지 못했습니다.`
    : `${label}: ${month}월에 해당하는 차수가 없어 차수를 정하지 못했습니다.`;
}

function makePayment({ foundId, key, label, month, round, files, fileResults }) {
  const { krw, rawValues, problem } = evaluateGroup(files, fileResults);
  const payment = { key, round, month, krw, fileKeys: files.map((file) => file.key), rawValues };
  const warnings = [
    ...(problem === null ? [] : [warn(problem.code, foundId, problemMessage(problem, label), key)]),
    ...(round === null ? [warn(WARNING.ROUND_UNMAPPED, foundId, roundMessage(label, month), key)] : []),
  ];
  return { payment, warnings };
}

function oncePayments(application, { fileResults, monthToRound }) {
  const { foundId, files } = application;
  const month = monthOfDate(application.date);
  const built = makePayment({
    foundId,
    key: foundId,
    label: `신청 ${foundId}`,
    month,
    round: roundOf(month, monthToRound),
    files,
    fileResults,
  });
  return { payments: [built.payment], warnings: built.warnings };
}

function monthlyPayments(application, { fileResults, monthToRound }) {
  const { foundId, files } = application;
  const months = [...new Set(files.map((file) => file.month).filter((month) => month !== null))].sort((a, b) => a - b);
  const built = months.map((month) => {
    const round = roundOf(month, monthToRound);
    const key = round === null ? null : `${foundId}-${round}${ROUND_SUFFIX}`;
    const label = key === null ? `신청 ${foundId}의 ${month}월 결제` : `결제 ${key}`;
    const monthFiles = files.filter((file) => file.month === month);
    return makePayment({ foundId, key, label, month, round, files: monthFiles, fileResults });
  });
  const orphans = files.filter((file) => file.month === null).map((file) => orphanWarning(foundId, file));
  return {
    payments: built.map((item) => item.payment),
    warnings: [...orphans, ...built.flatMap((item) => item.warnings)],
  };
}

function orphanWarning(foundId, file) {
  return warn(
    WARNING.FILE_WITHOUT_MONTH,
    foundId,
    `신청 ${foundId}: 월별 신청인데 파일 이름이 'N월'로 시작하지 않아 결제로 세지 않았습니다 (파일: ${fileLabel(file)}).`,
  );
}

function earlyFilesWarning(application) {
  const { foundId, evidenceStatus, files } = application;
  return warn(
    WARNING.FILES_BEFORE_COMPLETION,
    foundId,
    `신청 ${foundId}: 증빙접수가 '${evidenceStatus}' 상태인데 증빙 파일이 ${files.length}개 올라와 있습니다. 결제로 세지 않았습니다.`,
  );
}

function buildPayments(application, context) {
  const isCompleted = application.evidenceStatus === EVIDENCE_COMPLETED;
  const early = !isCompleted && application.files.length > 0 ? [earlyFilesWarning(application)] : [];
  if (!isCompleted || application.kind === KIND.NONE) return { payments: [], warnings: early };
  const build = application.kind === KIND.MONTHLY ? monthlyPayments : oncePayments;
  const built = build(application, context);
  return { payments: built.payments, warnings: [...early, ...built.warnings] };
}

function amountMismatchWarnings(application, view) {
  const differs = (viewValue, listValue) => viewValue !== null && viewValue !== listValue;
  if (!differs(view.requestedKrw, application.requestedKrw) && !differs(view.approvedKrw, application.approvedKrw)) {
    return [];
  }
  const { foundId } = application;
  const listAmounts = `신청 ${formatWon(application.requestedKrw)}, 승인 ${formatWon(application.approvedKrw)}`;
  const viewAmounts = `신청 ${formatWon(view.requestedKrw)}, 승인 ${formatWon(view.approvedKrw)}`;
  return [
    warn(WARNING.VIEW_MISMATCH, foundId, `신청 ${foundId}: 목록의 금액(${listAmounts})과 상세 화면의 금액(${viewAmounts})이 다릅니다.`),
  ];
}

function viewWarnings(application, view) {
  const { foundId } = application;
  if (view.title === null) {
    return [warn(WARNING.VIEW_UNPARSED, foundId, `신청 ${foundId}: 상세 화면에서 내용을 읽지 못해 품목과 금액을 확인하지 못했습니다.`)];
  }
  const noItems =
    application.kind === KIND.NONE && view.items.length === 0
      ? [warn(WARNING.NO_ITEMS, foundId, `신청 ${foundId}: 품목이 없는 0원 신청입니다.`)]
      : [];
  return [...amountMismatchWarnings(application, view), ...noItems];
}

function buildApplication(row, { views, evidences, fileResults, monthToRound }) {
  const view = parseViewText(views[row.foundId]?.text);
  const files = parseEvidenceLinks(evidences[row.foundId]?.anchors);
  const base = {
    foundId: row.foundId,
    category: row.category,
    title: row.title,
    author: row.author,
    date: row.date,
    status: row.status,
    evidenceStatus: row.evidenceStatus,
    requestedKrw: row.requested.krw,
    approvedKrw: row.approved.krw,
    items: view.items,
    kind: classify(row, files),
    files,
  };
  const paid = buildPayments(base, { fileResults, monthToRound });
  return {
    application: { ...base, payments: paid.payments },
    warnings: [...viewWarnings(base, view), ...paid.warnings],
  };
}

function browserWarnings(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.map((error) =>
    warn(
      WARNING.BROWSER_ERROR,
      null,
      `포털을 읽는 중 알림이 있었습니다 (${error?.where ?? '위치 모름'}): ${error?.message ?? '내용 없음'}`,
    ),
  );
}

export function buildSnapshot({ output, fileResults = {}, monthToRound = {} }) {
  const source = output ?? {};
  const { head, rows } = parseListPages(source.listPages);
  const context = { views: source.views ?? {}, evidences: source.evidences ?? {}, fileResults, monthToRound };
  const built = rows.map((row) => buildApplication(row, context));
  return {
    head,
    applications: built.map((item) => item.application),
    warnings: [...browserWarnings(source.errors), ...built.flatMap((item) => item.warnings)],
  };
}
