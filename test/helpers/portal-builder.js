// 실제 포털 화면 모양의 가짜 읽기 결과(read-portal.js가 쓰는 JSON)를 시험마다 짧게 만든다.
// 이름·번호·금액은 모두 지어낸 값이다.
const READ_AT = '2026-09-30T09:00:00.000Z';
const NAV = ['마이페이지', '신청/접수', '프로젝트 활동비'];
const LIST_HEADER = ['NO.', '구분', '제목', '신청금액', '승인금액', '상태', '증빙접수', '팀명', '작성자', '등록일'];
const TEAM_TABLE = [
  { cells: ['NO.', '팀명', '팀장'], links: [] },
  { cells: ['1', '가짜팀', '홍길동'], links: ['javascript:void(0);'] },
];
const NOTICE = '※ USD 외의 해외 결제는 금액 입력 후 ‘세부사항’에 단위(유로, 엔 등) 명시';

const DEFAULT_SPEC = {
  category: '기타',
  approved: 0,
  evidenceStatus: '증빙하기',
  date: '2026-08-05',
  items: 1,
  files: [],
  status: '승인',
  author: '홍길동',
};

export function fileKey(foundId, fileSn = 1) {
  return `f${foundId}:${fileSn}`;
}

function won(amount) {
  return `₩${amount.toLocaleString('en-US')}`;
}

function dotted(isoDate) {
  return isoDate === null ? '' : isoDate.replaceAll('-', '.');
}

function withDefaults(spec) {
  const merged = { ...DEFAULT_SPEC, ...spec };
  return { ...merged, requested: spec.requested ?? merged.approved };
}

function listRow(spec) {
  const link = (page) => `/busan/sw/mypage/projectSpt/${page}.do?foundId=${spec.foundId}&menuNo=200054&pageIndex=1`;
  return {
    cells: [
      '1',
      spec.category,
      spec.title ?? `${spec.category}(${spec.foundId})`,
      `${won(spec.requested)}\n$0`,
      `${won(spec.approved)}\n$0`,
      spec.status,
      spec.evidenceStatus,
      '가짜팀',
      spec.author,
      dotted(spec.date),
    ],
    links: [link('view'), link('view'), link('view'), link('view'), link('evidence'), link('evidence')],
  };
}

function listPage(index, total, rows, totalApproved) {
  return {
    url: `https://portal.example.test/busan/sw/mypage/teamFound/list.do?menuNo=200054&pageIndex=${index}`,
    text: `Total : ${total}\n총 승인금액 ₩ ${totalApproved.toLocaleString('en-US')} / $ 0`,
    tables: [TEAM_TABLE, [{ cells: LIST_HEADER, links: [] }, ...rows]],
    anchors: [],
  };
}

function itemBlock(number) {
  return [
    String(number),
    `품목명 가짜 품목 ${number}`,
    '결제방식 카드결제',
    '세부사항 없음',
    '수량 1',
    '신청금액 ₩0',
    '$0',
    NOTICE,
    '승인금액 ₩0',
    '$0',
    '구매사유 시험용 사유다.',
    '첨부파일',
    '가짜_첨부.png [10.00 KB , 2026-07-01 ]',
  ];
}

function viewPage(spec) {
  const items = Array.from({ length: spec.items }, (_, index) => itemBlock(index + 1)).flat();
  const lines = [
    ...NAV,
    `제목 ${spec.title ?? `${spec.category}(${spec.foundId})`}`,
    '구분 개발지원비',
    `상태 ${spec.status}`,
    `총 신청금액 ${won(spec.requested)}`,
    '$0',
    `총 승인금액 ${won(spec.approved)}`,
    '$0',
    `작성자 ${spec.author}`,
    `작성일 ${dotted(spec.date)}`,
    '신청내용',
    ...items,
    '멘토 평가의견',
    '멘토가',
    dotted(spec.date),
    '시험용 평가 의견이다.',
    '목록',
  ];
  return {
    url: `https://portal.example.test/busan/sw/mypage/projectSpt/view.do?foundId=${spec.foundId}&menuNo=200054`,
    text: lines.join('\n'),
    tables: [],
    anchors: [],
  };
}

function evidencePage(spec) {
  const anchors = spec.files.map((file, index) => {
    const { name, container } = typeof file === 'string' ? { name: file, container: undefined } : file;
    return {
      text: name,
      href: `/busan/sw/cmmn/file/fileDown.do?menuNo=200054&atchFileId=f${spec.foundId}&fileSn=${index + 1}`,
      ...(container === undefined ? {} : { container }),
    };
  });
  return {
    url: `https://portal.example.test/busan/sw/mypage/projectSpt/evidence.do?foundId=${spec.foundId}&menuNo=200054`,
    text: ['제목', '증빙서류', '첨부파일', ...spec.files.map((file) => (typeof file === 'string' ? file : file.name)), '저장'].join('\n'),
    tables: [],
    anchors,
  };
}

/**
 * specs: [{ foundId, category?, title?, requested?, approved?, evidenceStatus?, date?, items?, files?, status?, author? }]
 * files의 항목은 이름 문자열이거나 { name, container }이다. 파일 키는 fileKey(foundId, 순번)이다.
 */
export function makePortal(specs, { errors = [] } = {}) {
  const applications = specs.map(withDefaults);
  const totalApproved = applications.reduce((sum, spec) => sum + spec.approved, 0);
  const rows = applications.map(listRow);
  return {
    startedAt: READ_AT,
    finishedAt: READ_AT,
    loggedIn: true,
    listPages: [listPage(1, applications.length, rows, totalApproved), listPage(2, applications.length, [], totalApproved)],
    views: Object.fromEntries(applications.map((spec) => [spec.foundId, viewPage(spec)])),
    evidences: Object.fromEntries(applications.map((spec) => [spec.foundId, evidencePage(spec)])),
    downloads: [],
    errors,
  };
}

export function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
