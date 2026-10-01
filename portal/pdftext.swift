import PDFKit

// 증빙 PDF에서 글자를 뽑는다. pdftotext 같은 도구를 따로 설치하지 않으려고 macOS에 들어 있는 PDFKit을 쓴다.
// 쪽마다 "=== page N" 줄을 앞에 붙인다. 글자 없는 쪽(스캔 이미지)은 빈 채로 둔다.
// 종료 코드: 0 성공, 1 열지 못함(OPEN_FAIL), 2 사용법 오류, 3 암호가 걸려 있음(LOCKED).
guard CommandLine.arguments.count == 2 else {
  FileHandle.standardError.write("usage: pdftext <file.pdf>\n".data(using: .utf8)!)
  exit(2)
}
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let document = PDFDocument(url: url) else {
  FileHandle.standardError.write("OPEN_FAIL\n".data(using: .utf8)!)
  exit(1)
}
// 암호가 걸린 PDF도 열리기는 하지만 쪽의 글자가 비어 나온다. 그대로 두면 "금액 칸이 없는 파일"로 잘못 분류되므로
// 읽지 못한 파일로 알린다.
if document.isLocked {
  FileHandle.standardError.write("LOCKED\n".data(using: .utf8)!)
  exit(3)
}
for index in 0..<document.pageCount {
  print("=== page \(index + 1)")
  print(document.page(at: index)?.string ?? "")
}
