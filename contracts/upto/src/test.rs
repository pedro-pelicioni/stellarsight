extern crate std;

use crate::{Error, UptoSettlement, UptoSettlementClient, APPROVE_LEDGER_BUCKET};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthContract, MockAuthInvoke},
    token, xdr, Address, Env, IntoVal,
};

struct Fixture {
    env: Env,
    contract_id: Address,
    token_id: Address,
    payer: Address,
    pay_to: Address,
}

const START_BALANCE: i128 = 1_000;
const LEDGER_SEQ: u32 = 1_000;

fn setup() -> Fixture {
    let env = Env::default();
    env.ledger().set_sequence_number(LEDGER_SEQ);

    let contract_id = env.register(UptoSettlement, ());
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin);
    let token_id = sac.address();
    let payer = Address::generate(&env);
    let pay_to = Address::generate(&env);

    env.mock_all_auths();
    token::StellarAssetClient::new(&env, &token_id).mint(&payer, &START_BALANCE);

    Fixture {
        env,
        contract_id,
        token_id,
        payer,
        pay_to,
    }
}

fn client(f: &Fixture) -> UptoSettlementClient<'_> {
    UptoSettlementClient::new(&f.env, &f.contract_id)
}

fn token_client(f: &Fixture) -> token::TokenClient<'_> {
    token::TokenClient::new(&f.env, &f.token_id)
}

// ---- positive cases ----

#[test]
fn test_settle_partial() {
    let f = setup();
    f.env.mock_all_auths();

    client(&f).settle_upto(&f.token_id, &f.payer, &f.pay_to, &100, &40);

    assert_eq!(token_client(&f).balance(&f.pay_to), 40);
    assert_eq!(token_client(&f).balance(&f.payer), START_BALANCE - 40);
    assert_eq!(token_client(&f).balance(&f.contract_id), 0);
}

#[test]
fn test_settle_maximum() {
    let f = setup();
    f.env.mock_all_auths();

    client(&f).settle_upto(&f.token_id, &f.payer, &f.pay_to, &100, &100);

    assert_eq!(token_client(&f).balance(&f.pay_to), 100);
    assert_eq!(token_client(&f).balance(&f.payer), START_BALANCE - 100);
    assert_eq!(token_client(&f).balance(&f.contract_id), 0);
}

#[test]
fn test_settle_zero() {
    let f = setup();
    f.env.mock_all_auths();

    let result = client(&f).try_settle_upto(&f.token_id, &f.payer, &f.pay_to, &100, &0);

    assert_eq!(result, Ok(Ok(())));
    assert_eq!(token_client(&f).balance(&f.pay_to), 0);
    assert_eq!(token_client(&f).balance(&f.payer), START_BALANCE);
    assert_eq!(token_client(&f).balance(&f.contract_id), 0);
}

// ---- negative matrix ----

#[test]
fn test_above_maximum_rejected() {
    let f = setup();
    f.env.mock_all_auths();

    let result = client(&f).try_settle_upto(&f.token_id, &f.payer, &f.pay_to, &100, &101);

    assert_eq!(result, Err(Ok(Error::AboveMaximum)));
    assert_eq!(token_client(&f).balance(&f.payer), START_BALANCE);
}

#[test]
fn test_altered_recipient_rejected() {
    let f = setup();
    let other_recipient = Address::generate(&f.env);

    f.env.mock_auths(&[MockAuth {
        address: &f.payer,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "settle_upto",
            args: (f.token_id.clone(), f.pay_to.clone(), 100i128).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);

    let result =
        client(&f).try_settle_upto(&f.token_id, &f.payer, &other_recipient, &100, &40);

    assert!(result.is_err(), "altered recipient must not settle: {:?}", result);
    assert_eq!(token_client(&f).balance(&f.payer), START_BALANCE);
}

#[test]
fn test_altered_token_rejected() {
    let f = setup();
    let admin = Address::generate(&f.env);
    let other_sac = f.env.register_stellar_asset_contract_v2(admin);
    let other_token = other_sac.address();

    f.env.mock_auths(&[MockAuth {
        address: &f.payer,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "settle_upto",
            args: (f.token_id.clone(), f.pay_to.clone(), 100i128).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);

    let result =
        client(&f).try_settle_upto(&other_token, &f.payer, &f.pay_to, &100, &40);

    assert!(result.is_err(), "altered token must not settle: {:?}", result);
}

#[test]
fn test_unexpected_sub_invocation_rejected() {
    let f = setup();

    // Root call is authorized correctly, but the authorized tree carries no
    // sub-invocation — so the contract's own nested `approve` call, which
    // requires the payer's auth too, has nothing to match against.
    f.env.mock_auths(&[MockAuth {
        address: &f.payer,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "settle_upto",
            args: (f.token_id.clone(), f.pay_to.clone(), 100i128).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);

    let result = client(&f).try_settle_upto(&f.token_id, &f.payer, &f.pay_to, &100, &40);

    assert!(
        result.is_err(),
        "unauthorized sub-invocation must not settle: {:?}",
        result
    );
    assert_eq!(token_client(&f).balance(&f.payer), START_BALANCE);
}

/// Builds a real (non-mocked) authorization entry for `settle_upto`, with the
/// payer represented by a trivial always-authorize account contract so the
/// test can drive the host's own nonce/expiration enforcement directly
/// instead of doing real ed25519 signing.
fn set_controlled_auth(f: &Fixture, max: i128, nonce: i64, signature_expiration_ledger: u32) {
    f.env.register_at(&f.payer, MockAuthContract, ());

    let live_until = (LEDGER_SEQ / APPROVE_LEDGER_BUCKET + 1) * APPROVE_LEDGER_BUCKET;
    let approve_invoke = MockAuthInvoke {
        contract: &f.token_id,
        fn_name: "approve",
        args: (f.payer.clone(), f.contract_id.clone(), max, live_until).into_val(&f.env),
        sub_invokes: &[],
    };
    let root_invoke = MockAuthInvoke {
        contract: &f.contract_id,
        fn_name: "settle_upto",
        args: (f.token_id.clone(), f.pay_to.clone(), max).into_val(&f.env),
        sub_invokes: &[approve_invoke],
    };
    let mock = MockAuth {
        address: &f.payer,
        invoke: &root_invoke,
    };
    let mut entry: xdr::SorobanAuthorizationEntry = (&mock).into();
    if let xdr::SorobanCredentials::Address(creds) = &mut entry.credentials {
        creds.nonce = nonce;
        creds.signature_expiration_ledger = signature_expiration_ledger;
    }
    f.env.set_auths(&[entry]);
}

#[test]
fn test_expired_authorization_rejected() {
    let f = setup();
    // signature_expiration_ledger is behind the current ledger sequence.
    set_controlled_auth(&f, 100, 1, LEDGER_SEQ - 1);

    let result = client(&f).try_settle_upto(&f.token_id, &f.payer, &f.pay_to, &100, &40);

    assert!(result.is_err(), "expired authorization must not settle: {:?}", result);
    assert_eq!(token_client(&f).balance(&f.payer), START_BALANCE);
}

#[test]
fn test_replay_rejected() {
    let f = setup();
    set_controlled_auth(&f, 100, 7, LEDGER_SEQ + 100);

    client(&f).settle_upto(&f.token_id, &f.payer, &f.pay_to, &100, &40);
    assert_eq!(token_client(&f).balance(&f.pay_to), 40);

    // Re-submitting the identical signed entry (same nonce) must fail: Soroban
    // consumes the nonce on first use, so one signature settles once.
    let result = client(&f).try_settle_upto(&f.token_id, &f.payer, &f.pay_to, &100, &40);

    assert!(result.is_err(), "replayed authorization must not settle twice: {:?}", result);
    assert_eq!(token_client(&f).balance(&f.pay_to), 40);
}
