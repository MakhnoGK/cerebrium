//! Auth module.
use crate::util::{hash_token, Algo};
use std::collections::HashMap;

/// Token time-to-live, in seconds.
pub const TOKEN_TTL: u64 = 900;

/// A minted credential.
pub type Token = String;

/// Hashing algorithm.
pub enum Algo {
    Sha256,
    Blake3,
}

/// A thing that can check credentials.
pub trait Validator {
    /// Validate a set of login credentials.
    fn validate(&self, pw: &str) -> bool;
}

/// Auth business logic.
#[derive(Debug)]
pub struct AuthService {
    seen: HashMap<String, u64>,
}

impl AuthService {
    /// Issue a token for valid credentials.
    pub fn issue(&self, pw: &str) -> String {
        if self.validate(pw) {
            hash_token(pw)
        } else {
            String::new()
        }
    }
}

impl Validator for AuthService {
    fn validate(&self, pw: &str) -> bool {
        !hash_token(pw).is_empty()
    }
}

/// Construct a fresh service.
pub fn bootstrap() -> AuthService {
    AuthService {
        seen: HashMap::new(),
    }
}
