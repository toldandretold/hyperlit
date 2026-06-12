<?php

namespace App\Support;

/**
 * URL sanity checks shared by the citation scan (which computes url_flags) and
 * the review report (which re-validates CACHED flags before rendering — flags
 * are stored in bibliography.llm_metadata at scan time, so a fixed heuristic
 * must also be applied at render or stale false flags resurface forever).
 */
class UrlSanity
{
    /**
     * Is $tld a real top-level domain? All ISO 3166-1 country-code TLDs plus
     * common generic TLDs — legitimate non-US/UK domains (e.g. the Indian
     * government's pib.gov.in) must NOT be flagged as fabricated, while an
     * outright-invalid TLD string (e.g. "google.reports") still is.
     */
    public static function isValidTld(string $tld): bool
    {
        static $valid = null;
        if ($valid === null) {
            // ISO 3166-1 alpha-2 country-code TLDs
            $cc = 'ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et eu fi fj fk fm fo fr ga gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw';
            // Common generic TLDs
            $g = 'com org net edu gov mil int io co info biz dev app me ai tv cc xyz online site tech news blog store shop cloud media press email pro name mobi asia jobs travel coop museum aero gallery academy global world today live life work group network systems digital agency studio design law health church ngo ong eco';
            $valid = array_fill_keys(array_merge(explode(' ', $cc), explode(' ', $g)), true);
        }
        return isset($valid[$tld]);
    }
}
