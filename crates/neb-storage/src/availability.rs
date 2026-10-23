//! Runtime availability of a storage location, derived only from real operation results.
use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Availability {
    /// Not accessed in this process; startup never contacts remote storage.
    Unchecked = 0,
    Online = 1,
    /// Volume not mounted, host unreachable or timed out.
    Offline = 2,
    /// Credentials missing, rejected or the system credential store is unavailable.
    AuthRequired = 3,
    /// Certificate changed, expired or is not trusted.
    TrustRequired = 4,
    Error = 5,
}

impl Availability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unchecked => "unchecked",
            Self::Online => "online",
            Self::Offline => "offline",
            Self::AuthRequired => "auth_required",
            Self::TrustRequired => "trust_required",
            Self::Error => "error",
        }
    }

    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Online,
            2 => Self::Offline,
            3 => Self::AuthRequired,
            4 => Self::TrustRequired,
            5 => Self::Error,
            _ => Self::Unchecked,
        }
    }

    pub fn of<T>(result: &anyhow::Result<T>) -> Self {
        match result {
            Ok(_) => Self::Online,
            Err(error) => classify(error),
        }
    }
}

/// Shared between the registry and independent browser snapshots.
#[derive(Debug, Default)]
pub struct AvailabilityCell(AtomicU8);

impl AvailabilityCell {
    pub fn get(&self) -> Availability {
        Availability::from_u8(self.0.load(Ordering::Relaxed))
    }
    pub fn set(&self, value: Availability) {
        self.0.store(value as u8, Ordering::Relaxed);
    }
}

/// Classify a failed storage operation. Unknown failures stay `Error` rather than
/// being guessed as offline, so the UI never hides a real protocol problem.
pub fn classify(error: &anyhow::Error) -> Availability {
    for cause in error.chain() {
        if let Some(request) = cause.downcast_ref::<reqwest::Error>() {
            if request.is_connect() || request.is_timeout() {
                // A TLS handshake failure also surfaces as a connect error.
                return if certificate_text(&format!("{request:?}")) {
                    Availability::TrustRequired
                } else {
                    Availability::Offline
                };
            }
        }
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            use std::io::ErrorKind::*;
            if matches!(
                io.kind(),
                NotFound
                    | ConnectionRefused
                    | ConnectionReset
                    | ConnectionAborted
                    | NotConnected
                    | TimedOut
                    | HostUnreachable
                    | NetworkUnreachable
            ) {
                return Availability::Offline;
            }
        }
    }
    let text = format!("{error:#}");
    if certificate_text(&text) {
        Availability::TrustRequired
    } else if credential_text(&text) {
        Availability::AuthRequired
    } else if text.contains("is not a directory") || text.contains("disconnected or unavailable") {
        Availability::Offline
    } else {
        Availability::Error
    }
}

fn certificate_text(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "certificate",
        "unknownissuer",
        "fingerprint",
        "notvalidforname",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn credential_text(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("http 401")
        || lower.contains("http 403")
        || lower.contains("credentials are required")
        || lower.contains("credentials were not found")
        || lower.contains("enter them again")
        || lower.contains("credential store")
        || lower.contains("credential record")
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::anyhow;

    #[test]
    fn classifies_operation_failures_without_guessing() {
        let io = |kind| anyhow::Error::from(std::io::Error::from(kind)).context("Read failed");
        assert_eq!(
            classify(&io(std::io::ErrorKind::NotFound)),
            Availability::Offline
        );
        assert_eq!(
            classify(&io(std::io::ErrorKind::TimedOut)),
            Availability::Offline
        );
        assert_eq!(
            classify(&anyhow!("Storage request failed with HTTP 401")),
            Availability::AuthRequired
        );
        assert_eq!(
            classify(&anyhow!(
                "Saved credentials were not found in the system credential store; enter them again"
            )),
            Availability::AuthRequired
        );
        assert_eq!(
            classify(&anyhow!(
                "Device certificate does not match the pinned fingerprint"
            )),
            Availability::TrustRequired
        );
        assert_eq!(
            classify(&anyhow!("The local source path is not a directory")),
            Availability::Offline
        );
        assert_eq!(
            classify(&anyhow!("Invalid WebDAV listing")),
            Availability::Error
        );
        assert_eq!(
            classify(&anyhow!("Storage request failed with HTTP 500")),
            Availability::Error
        );
    }

    #[test]
    fn cell_round_trips_every_state() {
        let cell = AvailabilityCell::default();
        assert_eq!(cell.get(), Availability::Unchecked);
        for state in [
            Availability::Online,
            Availability::Offline,
            Availability::AuthRequired,
            Availability::TrustRequired,
            Availability::Error,
            Availability::Unchecked,
        ] {
            cell.set(state);
            assert_eq!(cell.get(), state);
        }
    }
}
