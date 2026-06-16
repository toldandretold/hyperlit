// Cross-concern mutable state for the cite-form, kept in a leaf so submission /
// validation / persistence / modes / search can share it without import cycles.
//  - allowedResubmitBookId: set after a footnote-audit "Re-submit" so the
//    submit-time + real-time validators skip the server uniqueness check for
//    that one id.
//  - searchState: the in-flight import-search bookkeeping (abort controller,
//    debounce timer, pagination offset, current query), shared by modes.ts
//    (which resets it on mode switch) and search.ts.
let allowedResubmitBookId: any = null;
export const getAllowedResubmitBookId = (): any => allowedResubmitBookId;
export const setAllowedResubmitBookId = (v: any): void => { allowedResubmitBookId = v; };

export const searchState: { abort: any; debounce: any; offset: number; query: string } = {
  abort: null,
  debounce: null,
  offset: 0,
  query: '',
};
