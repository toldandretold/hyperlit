<?php

namespace App\Services\Translation;

/**
 * Function-word profiles for BookLanguageDetector's ambiguous-script stage —
 * the ~30-40 highest-frequency STRUCTURE words per language (articles,
 * prepositions, conjunctions, pronouns, auxiliaries). On a whole-book sample
 * these are so frequent that a hit-rate comparison separates languages with a
 * wide margin; content words would only add noise.
 *
 * Words shared between languages (de/la/a/is/...) are deliberately tolerated —
 * the MARGIN requirement in the detector decides, not any single word. Close
 * pairs that genuinely overlap (cs/sk, da/nb, hr/sl, bg/sr) are all listed so
 * a Slovak book fails the margin against Czech and comes back NULL instead of
 * silently becoming "cs" — null beats a guess.
 *
 * All lowercase; tokens are matched after mb_strtolower on \p{L}+ runs, so
 * diacritics are preserved and load-bearing (år, že, että, głos...).
 */
final class StopwordProfiles
{
    /** @var array<string, array<string, string[]>> script => language => words */
    private const PROFILES = [
        'Latn' => [
            'en' => ['the', 'and', 'of', 'to', 'that', 'is', 'was', 'for', 'it', 'with', 'as', 'his', 'her', 'on', 'be', 'at', 'by', 'this', 'had', 'not', 'are', 'but', 'from', 'have', 'they', 'which', 'were', 'their', 'been', 'has', 'would', 'there', 'what', 'all', 'when', 'who', 'will', 'more', 'about', 'these'],
            'de' => ['der', 'die', 'das', 'und', 'nicht', 'von', 'sie', 'ist', 'des', 'sich', 'mit', 'dem', 'dass', 'er', 'es', 'ein', 'ich', 'auf', 'eine', 'auch', 'als', 'nach', 'wie', 'im', 'für', 'einen', 'um', 'werden', 'aber', 'bei', 'einer', 'aus', 'durch', 'wenn', 'nur', 'noch', 'über', 'zur', 'wird', 'sind', 'oder', 'zum', 'kann', 'haben', 'wurde'],
            'fr' => ['le', 'les', 'des', 'du', 'et', 'est', 'une', 'dans', 'que', 'qui', 'pas', 'pour', 'sur', 'avec', 'au', 'aux', 'ce', 'cette', 'ses', 'son', 'sa', 'mais', 'plus', 'où', 'nous', 'vous', 'ils', 'elle', 'être', 'sont', 'par', 'comme', 'tout', 'aussi', 'leur', 'bien', 'même', 'fait', 'été', 'dont'],
            'es' => ['el', 'los', 'las', 'del', 'y', 'en', 'que', 'es', 'un', 'una', 'por', 'con', 'no', 'para', 'su', 'al', 'lo', 'como', 'más', 'pero', 'sus', 'ya', 'este', 'porque', 'esta', 'entre', 'cuando', 'muy', 'sin', 'sobre', 'también', 'hasta', 'hay', 'donde', 'quien', 'desde', 'todo', 'nos', 'durante', 'está'],
            'it' => ['il', 'lo', 'gli', 'di', 'del', 'della', 'che', 'è', 'un', 'una', 'per', 'con', 'non', 'sono', 'si', 'come', 'anche', 'più', 'ma', 'nel', 'alla', 'questo', 'questa', 'hanno', 'essere', 'dalla', 'loro', 'quando', 'dove', 'se', 'tra', 'cui', 'degli', 'delle', 'dei', 'ha', 'al', 'nella', 'suo', 'stato'],
            'pt' => ['o', 'os', 'as', 'do', 'da', 'dos', 'das', 'e', 'em', 'que', 'é', 'um', 'uma', 'para', 'com', 'não', 'por', 'se', 'no', 'na', 'nos', 'mais', 'como', 'mas', 'foi', 'ao', 'ele', 'tem', 'à', 'seu', 'sua', 'ou', 'ser', 'quando', 'muito', 'há', 'pelo', 'pela', 'também', 'são'],
            'nl' => ['de', 'het', 'een', 'en', 'van', 'ik', 'te', 'dat', 'die', 'is', 'was', 'op', 'aan', 'met', 'als', 'voor', 'er', 'maar', 'om', 'dan', 'zou', 'wat', 'mijn', 'men', 'dit', 'zo', 'door', 'over', 'ze', 'zich', 'bij', 'ook', 'tot', 'je', 'uit', 'daar', 'haar', 'naar', 'heeft', 'niet', 'zijn', 'worden', 'wordt'],
            'pl' => ['i', 'w', 'nie', 'na', 'się', 'z', 'do', 'to', 'że', 'o', 'jak', 'ale', 'po', 'co', 'tak', 'za', 'przez', 'od', 'ich', 'tym', 'być', 'tylko', 'czy', 'jego', 'jej', 'już', 'bardzo', 'może', 'przy', 'które', 'który', 'która', 'oraz', 'są', 'jest', 'było', 'dla', 'był', 'także', 'między'],
            'sv' => ['och', 'att', 'det', 'som', 'en', 'på', 'är', 'av', 'för', 'med', 'till', 'den', 'har', 'de', 'inte', 'om', 'ett', 'han', 'men', 'var', 'jag', 'sig', 'från', 'vi', 'så', 'kan', 'när', 'år', 'under', 'också', 'efter', 'eller', 'nu', 'sin', 'där', 'vid', 'mot', 'ska', 'denna', 'vara'],
            'da' => ['og', 'at', 'det', 'en', 'den', 'til', 'er', 'som', 'på', 'de', 'med', 'han', 'af', 'for', 'ikke', 'der', 'var', 'sig', 'men', 'et', 'har', 'om', 'vi', 'havde', 'hun', 'nu', 'over', 'da', 'fra', 'du', 'ud', 'sin', 'dem', 'os', 'op', 'man', 'hvor', 'eller', 'hvad', 'skal'],
            'nb' => ['og', 'det', 'at', 'en', 'den', 'til', 'er', 'som', 'på', 'de', 'med', 'han', 'av', 'ikke', 'der', 'så', 'var', 'seg', 'men', 'et', 'har', 'om', 'vi', 'hadde', 'hun', 'nå', 'over', 'da', 'ved', 'fra', 'du', 'ut', 'sin', 'dem', 'oss', 'opp', 'man', 'kan', 'hvor', 'hva'],
            'fi' => ['ja', 'on', 'ei', 'se', 'että', 'oli', 'hän', 'mutta', 'ovat', 'kun', 'niin', 'myös', 'jotka', 'kuin', 'mukaan', 'hänen', 'sen', 'joka', 'ole', 'jo', 'vain', 'voi', 'siitä', 'tämä', 'tai', 'sitä', 'sekä', 'vielä', 'jos', 'mitä', 'tässä', 'kanssa', 'näin', 'kaikki', 'koska', 'ovat', 'olla', 'tämän'],
            'tr' => ['bir', 've', 'bu', 'için', 'ile', 'olarak', 'daha', 'çok', 'gibi', 'ancak', 'kadar', 'sonra', 'olan', 'ki', 'her', 'ne', 'ama', 'ise', 'veya', 'aynı', 'üzere', 'arasında', 'olduğu', 'değil', 'diye', 'böyle', 'bütün', 'bazı', 'çünkü', 'şu', 'onun', 'kendi', 'nasıl', 'zaman', 'olduğunu'],
            'id' => ['yang', 'dan', 'di', 'itu', 'dengan', 'untuk', 'tidak', 'ini', 'dari', 'dalam', 'akan', 'pada', 'juga', 'saya', 'ke', 'karena', 'tersebut', 'bisa', 'ada', 'mereka', 'lebih', 'kata', 'tahun', 'sudah', 'atau', 'saat', 'oleh', 'menjadi', 'orang', 'ia', 'telah', 'sebagai', 'masih', 'harus', 'sangat'],
            'ro' => ['și', 'la', 'în', 'este', 'cu', 'pe', 'care', 'mai', 'din', 'ce', 'nu', 'sunt', 'pentru', 'au', 'fost', 'sau', 'dar', 'când', 'prin', 'după', 'către', 'acest', 'această', 'dacă', 'până', 'între', 'foarte', 'fără', 'fiind', 'unui', 'unei', 'lor', 'său', 'sale', 'către'],
            'hu' => ['az', 'és', 'hogy', 'nem', 'is', 'egy', 'van', 'volt', 'el', 'meg', 'csak', 'ezt', 'már', 'mint', 'még', 'vagy', 'ha', 'amely', 'ami', 'azt', 'ez', 'így', 'mert', 'pedig', 'lehet', 'olyan', 'minden', 'után', 'között', 'által', 'nagyon', 'kell', 'majd', 'arra', 'ennek'],
            'cs' => ['se', 'na', 'je', 'že', 'z', 'do', 'to', 'jako', 'za', 'by', 'ale', 'po', 'co', 'tak', 'pro', 'jsou', 'byl', 'bylo', 'byla', 'jeho', 'který', 'která', 'které', 'při', 'od', 'nebo', 'už', 'jen', 'může', 'podle', 'mezi', 'také', 'být', 'než', 'aby', 'si', 'ještě', 'však'],
            'sk' => ['sa', 'na', 'je', 'že', 'z', 'do', 'to', 'ako', 'za', 'by', 'ale', 'po', 'čo', 'tak', 'pre', 'sú', 'bol', 'bolo', 'bola', 'jeho', 'ktorý', 'ktorá', 'ktoré', 'pri', 'od', 'alebo', 'už', 'len', 'môže', 'podľa', 'medzi', 'tiež', 'byť', 'než', 'aby', 'si', 'ešte', 'však'],
            'hr' => ['i', 'je', 'u', 'se', 'na', 'da', 'su', 'za', 's', 'od', 'koji', 'što', 'ali', 'ili', 'kao', 'to', 'po', 'iz', 'bio', 'bila', 'biti', 'ima', 'može', 'nije', 'samo', 'sve', 'kada', 'prema', 'nakon', 'zbog', 'već', 'dok', 'također', 'koja', 'koje'],
            'sl' => ['in', 'je', 'se', 'na', 'da', 'so', 'za', 's', 'z', 'od', 'ki', 'kot', 'pa', 'po', 'iz', 'bil', 'bila', 'biti', 'ima', 'lahko', 'ni', 'samo', 'vse', 'ko', 'proti', 'zaradi', 'že', 'še', 'tudi', 'med', 'bi', 'kar', 'bilo', 'tega'],
            'vi' => ['và', 'của', 'là', 'có', 'không', 'được', 'trong', 'cho', 'người', 'những', 'với', 'này', 'các', 'một', 'để', 'đã', 'khi', 'cũng', 'như', 'từ', 'ra', 'nhưng', 'về', 'đến', 'nhiều', 'sẽ', 'tại', 'theo', 'trên', 'việc', 'sau', 'bị', 'vào', 'đó'],
        ],
        'Cyrl' => [
            'ru' => ['и', 'в', 'не', 'на', 'что', 'с', 'он', 'как', 'это', 'по', 'но', 'из', 'его', 'к', 'у', 'за', 'от', 'так', 'же', 'то', 'бы', 'о', 'она', 'для', 'мы', 'они', 'при', 'был', 'была', 'было', 'если', 'или', 'только', 'когда', 'уже', 'можно', 'него', 'более'],
            'uk' => ['і', 'в', 'не', 'на', 'що', 'з', 'він', 'як', 'це', 'по', 'але', 'із', 'його', 'до', 'у', 'за', 'від', 'так', 'же', 'то', 'б', 'про', 'вона', 'для', 'ми', 'вони', 'при', 'був', 'була', 'було', 'якщо', 'або', 'тільки', 'коли', 'вже', 'можна', 'нього', 'більше', 'та', 'є'],
            'bg' => ['и', 'в', 'не', 'на', 'че', 'с', 'той', 'как', 'това', 'по', 'но', 'от', 'него', 'към', 'за', 'така', 'също', 'то', 'би', 'тя', 'ние', 'те', 'при', 'беше', 'бил', 'ако', 'или', 'само', 'когато', 'вече', 'може', 'повече', 'да', 'се', 'е', 'са', 'ще', 'които', 'който'],
            'sr' => ['и', 'у', 'не', 'на', 'да', 'са', 'он', 'као', 'то', 'по', 'али', 'из', 'до', 'код', 'за', 'од', 'тако', 'исто', 'би', 'она', 'ми', 'они', 'при', 'био', 'била', 'било', 'ако', 'или', 'само', 'када', 'већ', 'може', 'више', 'је', 'су', 'ће', 'се', 'која', 'који'],
        ],
        'Arab' => [
            'ar' => ['في', 'من', 'على', 'أن', 'إلى', 'عن', 'مع', 'هذا', 'هذه', 'التي', 'الذي', 'كان', 'كانت', 'لم', 'لا', 'ما', 'هو', 'هي', 'بعد', 'قبل', 'عند', 'كل', 'بين', 'حتى', 'إذا', 'ثم', 'أو', 'لكن', 'قد', 'وقد', 'غير', 'بعض', 'عندما', 'منذ'],
            'fa' => ['در', 'از', 'به', 'که', 'این', 'را', 'با', 'است', 'برای', 'آن', 'یک', 'خود', 'تا', 'بر', 'او', 'ما', 'هم', 'نیز', 'باید', 'شده', 'بود', 'می', 'های', 'اما', 'یا', 'اگر', 'هر', 'کرد', 'شد', 'دارد', 'وی', 'شود', 'کند'],
            'ur' => ['میں', 'سے', 'کو', 'کے', 'کی', 'کا', 'نے', 'پر', 'اور', 'ہے', 'ہیں', 'تھا', 'تھی', 'یہ', 'وہ', 'ایک', 'بھی', 'نہیں', 'لیے', 'ساتھ', 'بعد', 'اگر', 'لیکن', 'تک', 'جب', 'کچھ', 'ان', 'ہو', 'گیا', 'کر', 'رہا', 'اس'],
        ],
        'Deva' => [
            'hi' => ['है', 'का', 'की', 'के', 'में', 'से', 'को', 'और', 'पर', 'यह', 'कि', 'नहीं', 'एक', 'हैं', 'था', 'थी', 'भी', 'तो', 'ही', 'जो', 'ने', 'हो', 'कर', 'इस', 'वह', 'लिए', 'साथ', 'बाद', 'अगर', 'लेकिन', 'तक', 'जब', 'कुछ', 'उनके'],
            'mr' => ['आहे', 'आणि', 'च्या', 'मध्ये', 'ते', 'हे', 'या', 'तो', 'ती', 'एक', 'नाही', 'होते', 'होता', 'पण', 'म्हणून', 'तर', 'काही', 'त्यांच्या', 'केले', 'आला', 'आली', 'असून', 'येथे', 'झाले', 'करण्यात', 'आहेत'],
            'ne' => ['छ', 'र', 'को', 'मा', 'का', 'की', 'ले', 'लाई', 'हो', 'छन्', 'थियो', 'पनि', 'भने', 'गरेको', 'गर्न', 'भएको', 'तर', 'यो', 'उनी', 'हुन्', 'नै', 'गरी', 'छैन', 'हुने', 'गरेका'],
        ],
        'Beng' => [
            'bn' => ['এবং', 'করে', 'হয়', 'থেকে', 'এই', 'যে', 'তার', 'সঙ্গে', 'জন্য', 'না', 'তিনি', 'একটি', 'করা', 'হয়েছে', 'কিন্তু', 'আর', 'বা', 'এক', 'এর', 'তা', 'হবে', 'ছিল', 'কোনো', 'নিয়ে', 'পরে', 'মধ্যে', 'বলে', 'দিয়ে', 'আগে', 'এখন'],
            'as' => ['আৰু', 'কৰে', 'হয়', 'পৰা', 'এই', 'যে', 'তেওঁ', 'লগত', 'বাবে', 'নহয়', 'এটা', 'কৰা', 'হৈছে', 'কিন্তু', 'বা', 'এজন', 'ইয়াৰ', 'আছিল', 'কোনো', 'লৈ', 'পিছত', 'মাজত', 'বুলি', 'আগতে', 'এতিয়া'],
        ],
    ];

    /** @return array<string, string[]> language => words (empty if script has no profiles) */
    public static function for(string $script): array
    {
        return self::PROFILES[$script] ?? [];
    }
}
