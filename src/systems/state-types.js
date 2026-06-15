/**
 * Game state enum. Frozen so consumers can't accidentally mutate it.
 *
 * Kept in a separate file so the state machine module and the tests can
 * import the same constants without circular dependency pain.
 */
export const State = Object.freeze({
  DEMO: 'DEMO',
  PLAYING: 'PLAYING',
  GAME_OVER: 'GAME_OVER',
});
