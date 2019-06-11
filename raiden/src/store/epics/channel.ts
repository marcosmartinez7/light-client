import { ofType } from 'redux-observable';
import { Observable, from, of, EMPTY } from 'rxjs';
import {
  catchError,
  filter,
  map,
  mergeMap,
  mergeMapTo,
  tap,
  withLatestFrom,
} from 'rxjs/operators';
import { get, findKey } from 'lodash';

import { HashZero, Zero } from 'ethers/constants';

import { RaidenEpicDeps } from '../../types';
import { Channel, ChannelState } from '../../channels';
import { RaidenState } from '../state';
import {
  RaidenActionType,
  RaidenActions,
  ChannelOpenAction,
  ChannelOpenedAction,
  ChannelOpenActionFailed,
  ChannelMonitoredAction,
  ChannelDepositAction,
  ChannelDepositActionFailed,
  ChannelCloseAction,
  ChannelCloseActionFailed,
  ChannelSettleAction,
  ChannelSettleActionFailed,
  channelOpenFailed,
  channelMonitored,
  channelDepositFailed,
  channelCloseFailed,
  channelSettleFailed,
} from '../actions';
import { SignatureZero } from '../../constants';

/**
 * A channelOpen action requested by user
 * Needs to be called on a previously monitored tokenNetwork. Calls TokenNetwork.openChannel
 * with given parameters. If tx goes through successfuly, stop as ChannelOpened success action
 * will instead be detected and fired by tokenMonitoredEpic. If anything detectable goes wrong,
 * fires a ChannnelOpenActionFailed instead
 */
export const channelOpenEpic = (
  action$: Observable<RaidenActions>,
  state$: Observable<RaidenState>,
  { getTokenNetworkContract }: RaidenEpicDeps,
): Observable<ChannelOpenActionFailed> =>
  action$.pipe(
    ofType<RaidenActions, ChannelOpenAction>(RaidenActionType.CHANNEL_OPEN),
    withLatestFrom(state$),
    mergeMap(([action, state]) => {
      const tokenNetwork = getTokenNetworkContract(action.tokenNetwork);
      const channelState = get(state.tokenNetworks, [
        action.tokenNetwork,
        action.partner,
        'state',
      ]);
      // proceed only if channel is in 'opening' state, set by this action
      if (channelState !== ChannelState.opening)
        return of(
          channelOpenFailed(
            action.tokenNetwork,
            action.partner,
            new Error(`Invalid channel state: ${channelState}`),
          ),
        );

      // send openChannel transaction !!!
      return from(
        tokenNetwork.functions.openChannel(state.address, action.partner, action.settleTimeout),
      ).pipe(
        mergeMap(async tx => ({ receipt: await tx.wait(), tx })),
        map(({ receipt, tx }) => {
          if (!receipt.status) throw new Error(`openChannel transaction "${tx.hash}" failed`);
          return tx.hash;
        }),
        // if succeeded, return a empty/completed observable
        // actual ChannelOpenedAction will be detected and handled by tokenMonitoredEpic
        // if any error happened on tx call/pipeline, mergeMap below won't be hit, and catchError
        // will then emit the channelOpenFailed action instead
        mergeMapTo(EMPTY),
        catchError(error => of(channelOpenFailed(action.tokenNetwork, action.partner, error))),
      );
    }),
  );

/**
 * When we see a new ChannelOpenedAction event, starts monitoring channel
 */
export const channelOpenedEpic = (
  action$: Observable<RaidenActions>,
  state$: Observable<RaidenState>,
): Observable<ChannelMonitoredAction> =>
  action$.pipe(
    ofType<RaidenActions, ChannelOpenedAction>(RaidenActionType.CHANNEL_OPENED),
    withLatestFrom(state$),
    // proceed only if channel is in 'open' state and a deposit is required
    filter(([action, state]) => {
      const channel: Channel = get(state.tokenNetworks, [action.tokenNetwork, action.partner]);
      return channel && channel.state === ChannelState.open;
    }),
    map(([action]) =>
      channelMonitored(
        action.tokenNetwork,
        action.partner,
        action.id,
        action.openBlock, // fetch past events as well, if needed
      ),
    ),
  );

/**
 * A ChannelDeposit action requested by user
 * Needs to be called on a previously monitored channel. Calls Token.approve for TokenNetwork
 * and then set respective setTotalDeposit. If all tx go through successfuly, stop as
 * ChannelDeposited success action will instead be detected and reacted by
 * channelMonitoredEpic. If anything detectable goes wrong, fires a ChannelDepositActionFailed
 * instead
 */
export const channelDepositEpic = (
  action$: Observable<RaidenActions>,
  state$: Observable<RaidenState>,
  { address, getTokenContract, getTokenNetworkContract }: RaidenEpicDeps,
): Observable<ChannelDepositActionFailed> =>
  action$.pipe(
    ofType<RaidenActions, ChannelDepositAction>(RaidenActionType.CHANNEL_DEPOSIT),
    withLatestFrom(state$),
    mergeMap(([action, state]) => {
      const token = findKey(state.token2tokenNetwork, tn => tn === action.tokenNetwork);
      if (!token) {
        const error = new Error(`token for tokenNetwork "${action.tokenNetwork}" not found`);
        return of(channelDepositFailed(action.tokenNetwork, action.partner, error));
      }
      const tokenContract = getTokenContract(token);
      const tokenNetworkContract = getTokenNetworkContract(action.tokenNetwork);
      const channel: Channel = get(state.tokenNetworks, [action.tokenNetwork, action.partner]);
      if (!channel || channel.state !== ChannelState.open || channel.id === undefined) {
        const error = new Error(
          `channel for "${action.tokenNetwork}" and "${
            action.partner
          }" not found or not in 'open' state`,
        );
        return of(channelDepositFailed(action.tokenNetwork, action.partner, error));
      }
      const channelId = channel.id;

      // send approve transaction
      return from(tokenContract.functions.approve(action.tokenNetwork, action.deposit))
        .pipe(
          tap(tx => console.log(`sent approve tx "${tx.hash}" to "${token}"`)),
          mergeMap(async tx => ({ receipt: await tx.wait(), tx })),
          map(({ receipt, tx }) => {
            if (!receipt.status)
              throw new Error(`token "${token}" approve transaction "${tx.hash}" failed`);
            return tx.hash;
          }),
          tap(txHash => console.log(`approve tx "${txHash}" successfuly mined!`)),
        )
        .pipe(
          withLatestFrom(state$),
          mergeMap(([, state]) =>
            // send setTotalDeposit transaction
            tokenNetworkContract.functions.setTotalDeposit(
              channelId,
              address,
              state.tokenNetworks[action.tokenNetwork][action.partner].own.deposit.add(
                action.deposit,
              ),
              action.partner,
              { gasLimit: 100e3 },
            ),
          ),
          tap(tx =>
            console.log(`sent setTotalDeposit tx "${tx.hash}" to "${action.tokenNetwork}"`),
          ),
          mergeMap(async tx => ({ receipt: await tx.wait(), tx })),
          map(({ receipt, tx }) => {
            if (!receipt.status)
              throw new Error(
                `tokenNetwork "${action.tokenNetwork}" setTotalDeposit transaction "${
                  tx.hash
                }" failed`,
              );
            return tx.hash;
          }),
          tap(txHash => console.log(`setTotalDeposit tx "${txHash}" successfuly mined!`)),
          // if succeeded, return a empty/completed observable
          // actual ChannelDepositedAction will be detected and handled by channelMonitoredEpic
          // if any error happened on tx call/pipeline, mergeMap below won't be hit, and catchError
          // will then emit the channelDepositFailed action instead
          mergeMapTo(EMPTY),
          catchError(error =>
            of(channelDepositFailed(action.tokenNetwork, action.partner, error)),
          ),
        );
    }),
  );

/**
 * A ChannelClose action requested by user
 * Needs to be called on an opened or closing (for retries) channel.
 * If tx goes through successfuly, stop as ChannelClosed success action will instead be
 * detected and reacted by channelMonitoredEpic. If anything detectable goes wrong, fires a
 * ChannelCloseActionFailed instead
 */
export const channelCloseEpic = (
  action$: Observable<RaidenActions>,
  state$: Observable<RaidenState>,
  { getTokenNetworkContract }: RaidenEpicDeps,
): Observable<ChannelCloseActionFailed> =>
  action$.pipe(
    ofType<RaidenActions, ChannelCloseAction>(RaidenActionType.CHANNEL_CLOSE),
    withLatestFrom(state$),
    mergeMap(([action, state]) => {
      const tokenNetworkContract = getTokenNetworkContract(action.tokenNetwork);
      const channel: Channel = get(state.tokenNetworks, [action.tokenNetwork, action.partner]);
      if (
        !channel ||
        !(channel.state === ChannelState.open || channel.state === ChannelState.closing) ||
        !channel.id
      ) {
        const error = new Error(
          `channel for "${action.tokenNetwork}" and "${
            action.partner
          }" not found or not in 'open' or 'closing' state`,
        );
        return of(channelCloseFailed(action.tokenNetwork, action.partner, error));
      }
      const channelId = channel.id;

      // send closeChannel transaction
      return from(
        tokenNetworkContract.functions.closeChannel(
          channelId,
          action.partner,
          HashZero,
          0,
          HashZero,
          // FIXME: https://github.com/ethereum-ts/TypeChain/issues/123
          (SignatureZero as unknown) as string[],
        ),
      ).pipe(
        tap(tx => console.log(`sent closeChannel tx "${tx.hash}" to "${action.tokenNetwork}"`)),
        mergeMap(async tx => ({ receipt: await tx.wait(), tx })),
        map(({ receipt, tx }) => {
          if (!receipt.status)
            throw new Error(
              `tokenNetwork "${action.tokenNetwork}" closeChannel transaction "${tx.hash}" failed`,
            );
          console.log(`closeChannel tx "${tx.hash}" successfuly mined!`);
          return tx.hash;
        }),
        // if succeeded, return a empty/completed observable
        // actual ChannelClosedAction will be detected and handled by channelMonitoredEpic
        // if any error happened on tx call/pipeline, mergeMap below won't be hit, and catchError
        // will then emit the channelCloseFailed action instead
        mergeMapTo(EMPTY),
        catchError(error => of(channelCloseFailed(action.tokenNetwork, action.partner, error))),
      );
    }),
  );

/**
 * A ChannelSettle action requested by user
 * Needs to be called on an settleable or settling (for retries) channel.
 * If tx goes through successfuly, stop as ChannelSettled success action will instead be
 * detected and reacted by channelMonitoredEpic. If anything detectable goes wrong, fires a
 * ChannelSettleActionFailed instead
 */
export const channelSettleEpic = (
  action$: Observable<RaidenActions>,
  state$: Observable<RaidenState>,
  { address, getTokenNetworkContract }: RaidenEpicDeps,
): Observable<ChannelSettleActionFailed> =>
  action$.pipe(
    ofType<RaidenActions, ChannelSettleAction>(RaidenActionType.CHANNEL_SETTLE),
    withLatestFrom(state$),
    mergeMap(([action, state]) => {
      const tokenNetworkContract = getTokenNetworkContract(action.tokenNetwork);
      const channel: Channel = get(state.tokenNetworks, [action.tokenNetwork, action.partner]);
      if (
        !channel ||
        !(channel.state === ChannelState.settleable || channel.state === ChannelState.settling) ||
        !channel.id
      ) {
        const error = new Error(
          `channel for "${action.tokenNetwork}" and "${
            action.partner
          }" not found or not in 'settleable' or 'settling' state`,
        );
        return of(channelSettleFailed(action.tokenNetwork, action.partner, error));
      }
      const channelId = channel.id;

      // send settleChannel transaction
      return from(
        tokenNetworkContract.functions.settleChannel(
          channelId,
          address,
          Zero,
          Zero,
          HashZero,
          action.partner,
          Zero,
          Zero,
          HashZero,
        ),
      ).pipe(
        tap(tx => console.log(`sent settleChannel tx "${tx.hash}" to "${action.tokenNetwork}"`)),
        mergeMap(async tx => ({ receipt: await tx.wait(), tx })),
        map(({ receipt, tx }) => {
          if (!receipt.status)
            throw new Error(
              `tokenNetwork "${action.tokenNetwork}" settleChannel transaction "${
                tx.hash
              }" failed`,
            );
          console.log(`settleChannel tx "${tx.hash}" successfuly mined!`);
          return tx.hash;
        }),
        // if succeeded, return a empty/completed observable
        // actual ChannelSettledAction will be detected and handled by channelMonitoredEpic
        // if any error happened on tx call/pipeline, mergeMap below won't be hit, and catchError
        // will then emit the channelSettleFailed action instead
        mergeMapTo(EMPTY),
        catchError(error => of(channelSettleFailed(action.tokenNetwork, action.partner, error))),
      );
    }),
  );
