import { bigNumberify } from 'ethers/utils';
import * as t from 'io-ts';
import {
  RaidenActionType,
  channelDeposit,
  channelDepositFailed,
  channelMonitored,
  EnumType,
} from 'raiden/store';

describe('action factories not tested in reducers.spec.ts', () => {
  test('channelMonitor', () => {
    const tokenNetwork = '0xtokenNetwork',
      partner = '0xpartner',
      id = 12,
      fromBlock = 5123;
    expect(channelMonitored(tokenNetwork, partner, id, fromBlock)).toEqual({
      type: RaidenActionType.CHANNEL_MONITORED,
      tokenNetwork,
      partner,
      id,
      fromBlock,
    });
  });

  test('channelDeposit', () => {
    const tokenNetwork = '0xtokenNetwork',
      partner = '0xpartner',
      deposit = bigNumberify(999);
    expect(channelDeposit(tokenNetwork, partner, deposit)).toEqual({
      type: RaidenActionType.CHANNEL_DEPOSIT,
      tokenNetwork,
      partner,
      deposit,
    });
  });

  test('channelDepositFailed', () => {
    const tokenNetwork = '0xtokenNetwork',
      partner = '0xpartner',
      error = new Error('not enough funds');
    expect(channelDepositFailed(tokenNetwork, partner, error)).toEqual({
      type: RaidenActionType.CHANNEL_DEPOSIT_FAILED,
      tokenNetwork,
      partner,
      error,
    });
  });

  test('bla', () => {
    enum Test {
      TEST = 'Test',
    }
    const TestC = new EnumType<Test>(Test, 'Test');
    const Foo = t.type({ test: TestC });
    type Foo = t.TypeOf<typeof Foo>;

    const foo: Foo = { test: Test.TEST };
    expect(foo).toEqual({ test: 'Test' });
  });
});
