import {
  Props,
  Pose,
  PoserState,
  PoseMap,
  ChildPosers,
  GetTransitionProps,
  GetInstantTransition,
  StartAction,
  StopAction,
  ResolveTarget,
  TransformPose,
  AddTransitionDelay,
  ConvertTransitionDefinition
} from '../types';
import { getPoseValues } from '../inc/selectors';

type AnimationsPromiseList = Array<Promise<any>>;

type SetterFactoryProps<V, A, C, P> = {
  state: PoserState<V, A, C, P>;
  poses: PoseMap<A>;
  getInstantTransition: GetInstantTransition<V, A>;
  startAction: StartAction<V, A, C>;
  stopAction: StopAction<C>;
  addActionDelay: AddTransitionDelay<A>;
  getTransitionProps: GetTransitionProps<V>;
  resolveTarget: ResolveTarget<V>;
  convertTransitionDefinition: ConvertTransitionDefinition<A>;
  transformPose?: TransformPose<V, A, C, P>;
};

export const resolveProp = (target: any, props: Props) =>
  typeof target === 'function' ? target(props) : target;

const poseDefault = <A>(
  pose: Pose<A>,
  prop: string,
  defaultValue: any,
  resolveProps: Props
) =>
  pose && pose[prop] !== undefined
    ? resolveProp(pose[prop], resolveProps)
    : defaultValue;

const startChildAnimations = <V, A, C, P>(
  children: ChildPosers<V, A, C, P>,
  next: string,
  pose: Pose<A>,
  props: Props
) => {
  const animations: Array<Promise<any>> = [];
  const delay = poseDefault<A>(pose, 'delayChildren', 0, props);
  const stagger = poseDefault<A>(pose, 'staggerChildren', 0, props);
  const staggerDirection = poseDefault<A>(pose, 'staggerDirection', 1, props);

  const maxStaggerDuration = (children.size - 1) * stagger;
  const generateStaggerDuration =
    staggerDirection === 1
      ? (i: number) => i * stagger
      : (i: number) => maxStaggerDuration - i * stagger;

  Array.from(children).forEach((child, i) => {
    animations.push(
      child.set(next, {
        ...props,
        delay: delay + generateStaggerDuration(i)
      })
    );
  });

  return animations;
};

const resolveTransition = (
  transition,
  key,
  props,
  convertTransitionDefinition
) => {
  let resolvedTransition;

  /**
   * transition: () => {}
   */
  if (typeof transition === 'function') {
    resolvedTransition = transition(props);

    // Or if it's a keyed object
  } else if (transition[key]) {
    /**
     * transition: {
     *  x: () => {}
     * }
     */
    if (typeof transition[key] === 'function') {
      resolvedTransition = transition[key](props);

      /**
       * transition: {
       *  x: { type: 'tween' }
       * }
       */
    } else {
      resolvedTransition = transition[key];
    }

    /**
     * transition: { type: 'tween' }
     */
  } else {
    resolvedTransition = transition;
  }

  if (typeof resolvedTransition.start !== 'function') {
    resolvedTransition = convertTransitionDefinition(resolvedTransition);
  }

  return resolvedTransition;
};

const createPoseSetter = <V, A, C, P>(
  setterProps: SetterFactoryProps<V, A, C, P>
) => (next: string, nextProps: Props = {}) => {
  const {
    state,
    poses,
    startAction,
    stopAction,
    getInstantTransition,
    addActionDelay,
    getTransitionProps,
    resolveTarget,
    transformPose,
    convertTransitionDefinition
  } = setterProps;
  const { children, values, props, activeActions, activePoses } = state;

  const { delay = 0 } = nextProps;
  const hasChildren = children.size;
  let nextPose = poses[next];

  const baseTransitionProps = {
    ...props,
    ...nextProps
  };

  const getChildAnimations = (): AnimationsPromiseList =>
    hasChildren
      ? startChildAnimations(children, next, nextPose, baseTransitionProps)
      : [];

  const getParentAnimations = (): AnimationsPromiseList => {
    if (!nextPose) return [];

    if (transformPose) nextPose = transformPose(nextPose, next, state);

    const { preTransition, transition: getTransition } = nextPose;

    // Run pre-transition prep, if set
    if (preTransition) nextPose.preTransition(baseTransitionProps);

    return Object.keys(getPoseValues(nextPose)).map(key => {
      return new Promise(complete => {
        const value = values.get(key);

        const transitionProps = {
          ...baseTransitionProps,
          key,
          value
        };

        // Resolve target from pose
        const target = resolveTarget(
          value,
          resolveProp(nextPose[key], transitionProps)
        );

        // Stop the current action
        if (activeActions.has(key)) stopAction(activeActions.get(key));

        // Get the transition
        const resolveTransitionProps = {
          to: target,
          ...transitionProps,
          ...getTransitionProps(value, target, transitionProps)
        };
        let transition = resolveTransition(
          getTransition,
          key,
          resolveTransitionProps,
          convertTransitionDefinition
        );

        // If the transition is `false`, for no transition, set instantly
        if (transition === false)
          transition = getInstantTransition(value, resolveTransitionProps);

        // Add delay if defined on pose
        const poseDelay = resolveProp(nextPose.delay, transitionProps);
        if (delay || poseDelay) {
          transition = addActionDelay(delay || poseDelay, transition);
        }

        // Start transition
        activeActions.set(key, startAction(value, transition, complete));
        activePoses.set(key, next);
      });
    });
  };

  // Check before and afterChildren props to check if we need to reorder these animations
  if (nextPose && hasChildren) {
    // parent before children
    if (resolveProp(nextPose.beforeChildren, baseTransitionProps)) {
      return Promise.all(getParentAnimations()).then(() =>
        Promise.all(getChildAnimations())
      );

      // children before parent
    } else if (resolveProp(nextPose.afterChildren, baseTransitionProps)) {
      return Promise.all(getChildAnimations()).then(() =>
        Promise.all(getParentAnimations())
      );
    }
  }

  // Otherwise, run all animations in parallel
  return Promise.all([...getParentAnimations(), ...getChildAnimations()]);
};

export default createPoseSetter;
