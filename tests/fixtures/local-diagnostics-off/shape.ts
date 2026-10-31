/**
 * What a stand-in has to provide in place of a real module: every value export
 * with a compatible type, and for a class, every public static and instance member.
 */
type Shape<Module> = {
  [Name in keyof Module]: Module[Name] extends abstract new (
    ...args: infer Args
  ) => infer Instance
    ? Omit<Module[Name], 'prototype'> &
        (new (
          ...args: Args
        ) => Pick<Instance, keyof Instance>)
    : Module[Name]
}

/** `any` satisfies every shape, so no stand-in export may be `any`. */
type NoAny<Module> = {
  [Name in keyof Module]: 0 extends 1 & Module[Name] ? never : Module[Name]
}

/** Fails to typecheck when `StandIn` lacks or mistypes something `Real` exports. */
export type Covers<StandIn extends Shape<Real> & NoAny<StandIn>, Real> = StandIn
