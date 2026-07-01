// Barrel for the keydown guards extracted from divEditor/index.ts's document-level
// keydown listener. Each guard is a pure function that takes the live range/selection
// and returns whether it consumed the key, so the listener stays a thin dispatcher.
export { handleNoDeleteGuard } from './noDeleteGuard';
export { handleListItemBackspace } from './listItemBackspace';
