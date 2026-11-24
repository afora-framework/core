/**
 * How deep a value is read, in levels of objects and lists below it (the
 * value itself is level 0): a value nested deeper is rejected, so that a
 * small body (`[[[[...]]]]`) cannot make the walks over it (the copy a
 * record keeps, its masking, `JSON.stringify`, the check of a schema) run
 * long or overflow the stack, on every runtime.
 */
export const MAX_VALUE_DEPTH = 1000;

/** The issue message of a value nested deeper than `MAX_VALUE_DEPTH`. */
export const TOO_DEEP_MESSAGE = "is nested too deeply";
