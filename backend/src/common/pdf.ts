function escapePdf(value: unknown) {
  return String(value ?? "").replace(/[^\x20-\x7e]/g, " ").replace(/([\\()])/g, "\\$1");
}

export function renderPdfLines(lines: string[]) {
  const wrapped = lines.flatMap((line) => String(line).split(/\r?\n/).flatMap((part) => part.match(/.{1,48}/g) || [""]));
  const pages: string[][] = [];
  for (let index = 0; index < wrapped.length; index += 30) pages.push(wrapped.slice(index, index + 30));
  if (!pages.length) pages.push([]);
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (const [index, page] of pages.entries()) {
    const stream = `BT\n/F1 12 Tf\n50 750 Td\n${page.map((line, index) => `${index ? "0 -24 Td\n" : ""}(${escapePdf(line)}) Tj`).join("\n")}\nET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let output = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "ascii");
}
