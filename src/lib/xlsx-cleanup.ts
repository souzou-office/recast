// xlsx-cleanup.ts
// 生成済み xlsx の数式 (合計・割合など) を「Excel で開いた瞬間に必ず再計算」させる。
//
// ★なぜ必要か★
//   officecli はセルの値を書き換えるが、数式セル (=SUM(...) 等) の計算結果は再計算しない。
//   そのためテンプレに入っていた古いキャッシュ値がそのまま残り、合計や割合が実データと
//   合わない (例: 合計が 24756 のまま、本当は 105263)。Excel は通常 calcId が一致すると
//   キャッシュを信用して再計算をスキップするため、開いても古い値が出ることがある。
//
// ★なぜ officecli でなく XML 直接編集か★ (docx-cleanup.ts と同じ理由)
//   officecli の後処理は高負荷時 (Word プロセス枯渇) に無言で失敗する。PizZip で
//   workbook.xml を直接いじれば負荷状況に関係なく決定論的に効く。LibreOffice も不要。
//
// 仕組み: workbook.xml の <calcPr> に fullCalcOnLoad="1" を立てる。これで Excel は
//   開いた時に全数式を強制再計算する → 合計・割合が常に正しくなる。

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZip = require("pizzip");

export function ensureXlsxRecalc(buf: Buffer): { buf: Buffer; changed: boolean } {
  let zip: InstanceType<typeof PizZip>;
  try {
    zip = new PizZip(buf);
  } catch {
    return { buf, changed: false }; // xls(バイナリ)等、zip でなければ何もしない
  }
  const wbFile = zip.file("xl/workbook.xml");
  if (!wbFile) return { buf, changed: false };

  let xml: string = wbFile.asText();
  let changed = false;

  if (/<(?:\w+:)?calcPr\b/.test(xml)) {
    // 既存 calcPr に fullCalcOnLoad="1" を付与/更新 (名前空間プレフィックス x: にも対応)
    xml = xml.replace(/<((?:\w+:)?)calcPr\b([^>]*?)\s*\/?>/, (_m, ns: string, attrs: string) => {
      const a = /fullCalcOnLoad=/.test(attrs)
        ? attrs.replace(/fullCalcOnLoad="[^"]*"/, 'fullCalcOnLoad="1"')
        : `${attrs} fullCalcOnLoad="1"`;
      changed = true;
      return `<${ns}calcPr${a}/>`;
    });
  } else {
    // calcPr が無い → </workbook> 直前に挿入
    xml = xml.replace(/<\/((?:\w+:)?)workbook>/, (_m, ns: string) => {
      changed = true;
      return `<${ns}calcPr calcId="0" fullCalcOnLoad="1"/></${ns}workbook>`;
    });
  }

  if (!changed) return { buf, changed: false };
  zip.file("xl/workbook.xml", xml);
  return { buf: zip.generate({ type: "nodebuffer", compression: "DEFLATE" }), changed: true };
}
