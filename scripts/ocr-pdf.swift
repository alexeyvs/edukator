// Распознавание отдельных страниц PDF через системный Vision (macOS).
//
// Все три учебника — сканы без текстового слоя, поэтому `extract-toc.ts`
// откатывается сюда. Vision выбран вместо tesseract/ocrmypdf сознательно: он
// уже есть в системе, умеет русский и не требует ни установки, ни загрузки
// языковых моделей. Плата за это — скрипт работает только на macOS.
//
// Вызов:  swift scripts/ocr-pdf.swift <путь к pdf> <номера страниц через запятую>
// Ответ:  JSON [{"num": 333, "text": "..."}] в stdout, ошибки — в stderr.

import AppKit
import Foundation
import PDFKit
import Vision

struct Page: Encodable {
    let num: Int
    let text: String
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(("ocr-pdf: " + message + "\n").data(using: .utf8)!)
    exit(1)
}

guard CommandLine.arguments.count == 3 else {
    fail("нужны два аргумента: путь к PDF и номера страниц через запятую")
}

let path = CommandLine.arguments[1]
let requested = CommandLine.arguments[2]
    .split(separator: ",")
    .compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }

guard !requested.isEmpty else { fail("не указано ни одной страницы") }
guard let document = PDFDocument(url: URL(fileURLWithPath: path)) else {
    fail("не удалось открыть PDF: \(path)")
}

// Разрешение рендера. При 1.0 скан книги распознаётся заметно хуже: строки
// оглавления тонкие, а номера страниц мелкие.
let scale: CGFloat = 2.0

// Пропущенная страница — это ошибка, а не повод продолжить: вызывающий сверяет
// номера не сам, и укороченный ответ выглядит ровно как полный. Оглавление,
// потерявшее середину, дошло бы до карты тем никак не помеченным.
var pages: [Page] = []
for number in requested {
    guard number >= 1, number <= document.pageCount else {
        fail("страница \(number) вне книги (страниц: \(document.pageCount))")
    }
    guard let page = document.page(at: number - 1) else {
        fail("страница \(number) не читается")
    }

    let bounds = page.bounds(for: .mediaBox)
    let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)
    let image = page.thumbnail(of: size, for: .mediaBox)
    guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        fail("страница \(number) не отрисовалась в растр")
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["ru-RU", "en-US"]
    request.usesLanguageCorrection = true

    do {
        try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
    } catch {
        fail("распознавание страницы \(number) не удалось: \(error.localizedDescription)")
    }

    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    pages.append(Page(num: number, text: lines.joined(separator: "\n")))
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.withoutEscapingSlashes]
guard let json = try? encoder.encode(pages), let text = String(data: json, encoding: .utf8) else {
    fail("не удалось сериализовать результат")
}
print(text)
