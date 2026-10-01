import CoreGraphics
import CoreText
import PDFKit

// 시험용 PDF 두 개를 만든다: 글자가 든 한 쪽짜리 PDF와, 같은 내용에 열기 암호를 건 PDF.
// 암호가 걸린 PDF를 손으로 쓰기는 어려워서 PDFKit으로 만든다. 글자와 암호는 모두 지어낸 값이다.
guard CommandLine.arguments.count == 3 else {
  FileHandle.standardError.write("usage: make-test-pdfs <plain.pdf> <locked.pdf>\n".data(using: .utf8)!)
  exit(2)
}
let plainURL = URL(fileURLWithPath: CommandLine.arguments[1])
let lockedURL = URL(fileURLWithPath: CommandLine.arguments[2])

var mediaBox = CGRect(x: 0, y: 0, width: 300, height: 200)
guard let context = CGContext(plainURL as CFURL, mediaBox: &mediaBox, nil) else { exit(1) }
context.beginPDFPage(nil)
let font = CTFontCreateWithName("Helvetica" as CFString, 14, nil)
let text = NSAttributedString(string: "Amount test 1000", attributes: [.font: font])
context.textPosition = CGPoint(x: 20, y: 100)
CTLineDraw(CTLineCreateWithAttributedString(text), context)
context.endPDFPage()
context.closePDF()

guard let document = PDFDocument(url: plainURL) else { exit(3) }
let password = "password-for-tests"
let options: [PDFDocumentWriteOption: Any] = [
  .userPasswordOption: password,
  .ownerPasswordOption: password,
]
guard document.write(to: lockedURL, withOptions: options) else { exit(4) }
