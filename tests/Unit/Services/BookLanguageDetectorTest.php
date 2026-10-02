<?php

/**
 * BookLanguageDetector — pure string→code, no DB.
 *
 * The contract: a confident code or NULL, never a guess. The thresholds are
 * load-bearing — the ~90-char English case pins the floor the e2e reader
 * fixture depends on (E2E_READER_BOOK carries ~92 chars of English), and the
 * below-floor case pins what keeps StructuredDataTest's one-node seed
 * undetectable.
 */

use App\Services\Translation\BookLanguageDetector;
use App\Services\Translation\BookTextSampler;

/* ── Latin-script languages via stopword vote ────────────────────────── */

it('detects Latin-script languages from function words', function (string $expected, string $text) {
    expect(BookLanguageDetector::detect($text))->toBe($expected);
})->with([
    ['en', 'The history of the modern world cannot be understood without an analysis of the social structures that were formed under colonial rule, and the scholars who have studied this period argue that its consequences are still with us.'],
    ['de', 'Die Geschichte der Philosophie ist nicht nur eine Geschichte der Ideen, sondern auch eine Geschichte der Menschen, die sie gedacht haben, und der Begriff wird oft verwendet, um das Verhältnis zwischen Theorie und Praxis zu beschreiben.'],
    ['fr', "La théorie des relations internationales est un champ d'étude qui s'intéresse aux relations entre les États, et les chercheurs ont montré que la coopération est possible même dans un monde anarchique, mais cette conclusion ne fait pas l'unanimité."],
    ['es', 'La historia de América Latina es una historia de resistencia y de lucha, porque los pueblos del continente han enfrentado siglos de dominación colonial, pero también han construido formas propias de organización política y social.'],
    ['pt', 'A formação do Brasil contemporâneo não pode ser entendida sem uma análise das estruturas coloniais que moldaram a sociedade, e os autores mostram que o processo de modernização foi marcado por profundas desigualdades.'],
    ['it', 'La questione meridionale è stata al centro del dibattito politico italiano per più di un secolo, e gli studiosi hanno proposto diverse interpretazioni del divario tra il nord e il sud del paese, ma nessuna di queste è riuscita a spiegarlo.'],
    ['nl', 'De geschiedenis van de Nederlandse koloniale expansie is een verhaal dat lang niet verteld werd, maar het onderzoek laat zien dat de gevolgen van het kolonialisme nog steeds voelbaar zijn in de hedendaagse samenleving.'],
    ['pl', 'Historia Polski jest pełna dramatycznych zwrotów, a badacze od dawna zwracają uwagę na to, że tożsamość narodowa kształtowała się pod wpływem wielu czynników, ale dopiero teraz możemy zobaczyć pełny obraz tego procesu.'],
    ['tr', "Türkiye'nin modernleşme tarihi, Osmanlı İmparatorluğu'nun son döneminden bu yana devam eden bir süreçtir ve araştırmacılar bu sürecin toplumsal yapı üzerindeki etkilerini farklı açılardan incelemişlerdir, ancak henüz tam bir uzlaşma sağlanamamıştır."],
]);

/* ── Cyrillic: ru vs uk separated by their distinct function words ───── */

it('separates Russian from Ukrainian', function () {
    $ru = 'История русской литературы девятнадцатого века не может быть понята без анализа социальных условий, в которых она создавалась, и писатели этого периода были не только художниками, но и мыслителями.';
    $uk = 'Історія України є складною та багатогранною, і дослідники вже давно звернули увагу на те, що національна ідентичність формувалася під впливом багатьох чинників, але тільки тепер ми можемо побачити повну картину.';

    expect(BookLanguageDetector::detect($ru))->toBe('ru')
        ->and(BookLanguageDetector::detect($uk))->toBe('uk');
});

/* ── CJK: presence rules, not dominance ──────────────────────────────── */

it('calls majority-Han Japanese text ja, not zh (kana presence wins)', function () {
    // Japanese academic prose is majority-Han by character count — a
    // dominant-script test alone reads it as Chinese.
    $ja = '日本の歴史は長く複雑である。研究者たちは明治維新がもたらした変化について多くの議論を重ねてきた。しかし近代化の過程で失われたものについてはまだ十分に検討されていない。';
    expect(BookLanguageDetector::detect($ja))->toBe('ja');
});

it('calls hangul text ko and pure Han text zh (never Hans/Hant)', function () {
    $ko = '한국의 역사는 오랜 전통을 가지고 있다. 연구자들은 조선 시대의 사회 구조에 대해 많은 연구를 수행해 왔다. 그러나 아직도 밝혀지지 않은 부분이 많으며 앞으로의 연구가 필요한 상황이다.';
    $zh = '中国历史悠久，文化灿烂。几千年来，中华民族创造了丰富多彩的文明成果。从古代的四大发明到现代的科技进步，中国人民始终在探索和创新。历史学家认为，要理解当代中国，必须深入研究其历史传统。';

    expect(BookLanguageDetector::detect($ko))->toBe('ko')
        ->and(BookLanguageDetector::detect($zh))->toBe('zh');
});

/* ── single-language scripts map directly ────────────────────────────── */

it('maps single-language scripts without a stopword vote', function () {
    $th = 'ประวัติศาสตร์ไทยสมัยใหม่เป็นเรื่องที่ซับซ้อน นักวิชาการได้ศึกษาการเปลี่ยนแปลงทางสังคมและการเมืองมาอย่างยาวนาน แต่ยังมีประเด็นอีกมากที่ต้องการการค้นคว้าเพิ่มเติม';
    $el = 'Η ιστορία της νεοελληνικής λογοτεχνίας είναι ένα πεδίο με πολλές αντιπαραθέσεις και οι μελετητές έχουν προτείνει διαφορετικές περιοδολογήσεις, αλλά καμία δεν έχει γίνει καθολικά αποδεκτή.';
    $he = 'ההיסטוריה של הספרות העברית החדשה היא סיפור מרתק של תחייה תרבותית, וחוקרים רבים עסקו בשאלת היחס בין המסורת לחידוש, אך טרם ניתנה תשובה מלאה לשאלה כיצד השפיעו תהליכים אלה על החברה.';

    expect(BookLanguageDetector::detect($th))->toBe('th')
        ->and(BookLanguageDetector::detect($el))->toBe('el')
        ->and(BookLanguageDetector::detect($he))->toBe('he');
});

it('detects Hindi — Devanagari matras must stay inside tokens', function () {
    // Brahmic vowel signs are combining MARKS (\p{M}); a \p{L}-only tokenizer
    // splits "में" into debris and no profile word ever matches.
    $hi = 'भारत का इतिहास बहुत पुराना है। विद्वानों ने इस बात पर ध्यान दिया है कि औपनिवेशिक काल में समाज की संरचना में गहरे परिवर्तन हुए। लेकिन यह भी सच है कि प्रतिरोध की परंपरा हमेशा जीवित रही।';
    expect(BookLanguageDetector::detect($hi))->toBe('hi');
});

it('detects Arabic-script Arabic', function () {
    $ar = 'إن تاريخ العالم العربي الحديث لا يمكن فهمه من دون تحليل البنى الاجتماعية والاقتصادية التي تشكلت في ظل الاستعمار، وقد أظهرت الدراسات أن عملية التحديث كانت مشوهة منذ البداية.';
    expect(BookLanguageDetector::detect($ar))->toBe('ar');
});

/* ── refusals: null beats a guess ────────────────────────────────────── */

it('returns null below the sample floor', function () {
    // Pins what keeps StructuredDataTest's one-node "<p>Body</p>" seed
    // undetectable — a four-character sample is not evidence of anything.
    expect(BookLanguageDetector::detect('Body'))->toBeNull()
        ->and(BookLanguageDetector::detect(''))->toBeNull();
});

it('returns null for Latin gibberish with no function-word signal', function () {
    $noise = 'xq zvw plk mnt rst uvx yzq abc defg hijk lmno pqrs tuvw xyzz qwer asdf zxcv bnml poiu ytre wqas dfgh jklz xcvb nmqw erty uiop asdf ghjk';
    expect(BookLanguageDetector::detect($noise))->toBeNull();
});

it('returns null when the margin between close languages fails', function () {
    // Words Czech and Slovak share — neither may win on this evidence.
    $close = 'to je na se do za po tak pro od si to je na se do za po tak pro od si to je na se do za po tak pro od si';
    expect(BookLanguageDetector::detect($close))->toBeNull();
});

it('detects a ~90-char English snippet (the e2e reader fixture floor)', function () {
    // E2E_READER_BOOK carries ~92 chars of English prose; the axe a11y suite
    // needs it to detect so the reader page serves <html lang>.
    $short = "Test book 1. This is going to be a link to test book 2: 'During their wartime and immed'";
    expect(BookLanguageDetector::detect($short))->toBe('en');
});

/* ── the sampler's text extraction ───────────────────────────────────── */

it('textOf drops footnote sups, latex and furniture, decodes entities', function () {
    $html = '<p>Der Begriff <sup fn-count-id="3">3</sup> wird oft <latex data-math="x^2">x²</latex> verwendet &amp; gesch&auml;tzt <span class="open-icon">↗</span>.</p>';
    expect(BookTextSampler::textOf($html))->toBe('Der Begriff wird oft verwendet & geschätzt .');
});
