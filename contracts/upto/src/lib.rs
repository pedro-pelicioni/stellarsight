#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, token, Address, Env, IntoVal};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AboveMaximum = 1,
}

// no admin, no upgrade path, no persistent storage, never holds a balance
#[contract]
pub struct UptoSettlement;

// The nested `approve` call's `live_until_ledger` is itself part of what the payer's
// authorization tree binds, via the token contract's own `from.require_auth()`. That
// tree is fixed at simulation time but re-checked against what the contract actually
// does at apply time, which is always a later ledger — Soroban submission is always
// simulate-then-submit, never same-ledger. A raw `env.ledger().sequence()` would
// therefore mismatch on nearly every real submission. Rounding up to a coarse bucket
// keeps the value stable across ordinary simulate-to-apply drift (a handful of ledgers,
// well under a minute) while still expiring the allowance well short of anything that
// could be called a standing approval.
pub(crate) const APPROVE_LEDGER_BUCKET: u32 = 50;

#[contractimpl]
impl UptoSettlement {
    pub fn settle_upto(
        env: Env,
        token: Address,
        payer: Address,
        pay_to: Address,
        max: i128,
        actual: i128,
    ) -> Result<(), Error> {
        payer.require_auth_for_args((token.clone(), pay_to.clone(), max).into_val(&env));

        if actual > max {
            return Err(Error::AboveMaximum);
        }

        let client = token::TokenClient::new(&env, &token);
        let contract_address = env.current_contract_address();
        let live_until = (env.ledger().sequence() / APPROVE_LEDGER_BUCKET + 1) * APPROVE_LEDGER_BUCKET;
        // approve nested inside the payer's authorization tree; transfer_from pays
        // pay_to directly from payer — this contract never holds a balance.
        client.approve(&payer, &contract_address, &max, &live_until);
        client.transfer_from(&contract_address, &payer, &pay_to, &actual);

        Ok(())
    }
}

#[cfg(test)]
mod test;
