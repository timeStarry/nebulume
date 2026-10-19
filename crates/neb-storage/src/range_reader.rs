//! Version-locked HTTP ranges. This reader never falls back to a full GET.
use crate::{remote, transport, Credentials, StorageConfig};
use reqwest::{
    blocking::{Client, RequestBuilder, Response},
    header::{
        HeaderMap, HeaderName, ACCEPT_ENCODING, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE,
        ETAG, IF_MATCH, RANGE, TRANSFER_ENCODING,
    },
    Method, StatusCode,
};
use std::{
    collections::VecDeque,
    error::Error,
    fmt,
    io::{self, Read, Seek, SeekFrom},
};

const MAX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_REQUESTS: u32 = 128;
const MAX_CHUNK: usize = 256 * 1024;
const MAX_CACHED_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug)]
pub struct RangeReadOptions {
    pub chunk_size: usize,
    pub max_bytes: u64,
    pub max_requests: u32,
    pub max_cached_chunks: usize,
}

impl Default for RangeReadOptions {
    fn default() -> Self {
        Self {
            chunk_size: MAX_CHUNK,
            max_bytes: MAX_BYTES,
            max_requests: MAX_REQUESTS,
            max_cached_chunks: 8,
        }
    }
}

impl RangeReadOptions {
    fn validate(self) -> Result<Self, RangeReadError> {
        if self.chunk_size == 0
            || self.chunk_size > MAX_CHUNK
            || self.max_bytes == 0
            || self.max_bytes > MAX_BYTES
            || self.max_requests == 0
            || self.max_requests > MAX_REQUESTS
            || self.max_cached_chunks == 0
            || self
                .chunk_size
                .checked_mul(self.max_cached_chunks)
                .is_none_or(|bytes| bytes > MAX_CACHED_BYTES)
        {
            return Err(RangeReadError::InvalidOptions);
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RangeReadError {
    Unsupported,
    VersionUnavailable,
    VersionChanged,
    InvalidResponse(&'static str),
    BudgetExceeded,
    HttpStatus(u16),
    Transport,
    InvalidOptions,
}

impl RangeReadError {
    pub fn is_fallback_allowed(&self) -> bool {
        matches!(self, Self::Unsupported | Self::VersionUnavailable)
    }
    pub fn from_io(error: &io::Error) -> Option<&Self> {
        error.get_ref()?.downcast_ref()
    }
    fn into_io(self) -> io::Error {
        let kind = match self {
            Self::Unsupported | Self::VersionUnavailable => io::ErrorKind::Unsupported,
            Self::InvalidOptions => io::ErrorKind::InvalidInput,
            Self::InvalidResponse(_) | Self::VersionChanged => io::ErrorKind::InvalidData,
            _ => io::ErrorKind::Other,
        };
        io::Error::new(kind, self)
    }
}

impl fmt::Display for RangeReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported => {
                f.write_str("E_RANGE_UNSUPPORTED: Server does not support bounded byte ranges")
            }
            Self::VersionUnavailable => {
                f.write_str("E_RANGE_VERSION: A strong remote object version is unavailable")
            }
            Self::VersionChanged => {
                f.write_str("E_RANGE_CHANGED: Remote object version changed during reading")
            }
            Self::InvalidResponse(reason) => write!(f, "E_RANGE_PROTOCOL: {reason}"),
            Self::BudgetExceeded => f.write_str("E_RANGE_LIMIT: Remote range read budget exceeded"),
            Self::HttpStatus(status) => write!(f, "E_RANGE_HTTP: Server returned HTTP {status}"),
            Self::Transport => f.write_str("E_RANGE_TRANSPORT: Remote range request failed"),
            Self::InvalidOptions => f.write_str("E_RANGE_INVALID: Invalid range reader limits"),
        }
    }
}
impl Error for RangeReadError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RangeObjectIdentity {
    pub length: u64,
    pub etag: Option<String>,
    pub version_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RangeReadStats {
    pub requests: u32,
    pub body_bytes: u64,
    pub cached_bytes: usize,
}

/// Owns a private connection/credential snapshot. No Debug or serialization
/// implementation is provided for the reader or its authentication state.
pub struct RemoteRangeReader {
    client: Option<Client>,
    config: StorageConfig,
    credentials: Credentials,
    url: url::Url,
    options: RangeReadOptions,
    identity: Option<RangeObjectIdentity>,
    position: u64,
    requests: u32,
    body_bytes: u64,
    blocks: VecDeque<(u64, Vec<u8>)>,
    failure: Option<RangeReadError>,
}

impl RemoteRangeReader {
    pub(crate) fn new(
        client: Option<Client>,
        config: StorageConfig,
        credentials: Credentials,
        key: &str,
        options: RangeReadOptions,
    ) -> Result<Self, RangeReadError> {
        let options = options.validate()?;
        let url = remote::url_for(&config, key)
            .map_err(|_| RangeReadError::InvalidResponse("Invalid remote object path"))?;
        Ok(Self {
            client,
            config,
            credentials,
            url,
            options,
            identity: None,
            position: 0,
            requests: 0,
            body_bytes: 0,
            blocks: VecDeque::new(),
            failure: None,
        })
    }

    pub fn metadata(&mut self) -> io::Result<RangeObjectIdentity> {
        if let Some(error) = &self.failure {
            return Err(error.clone().into_io());
        }
        if self.identity.is_none() {
            match self.inspect() {
                Ok(identity) => self.identity = Some(identity),
                Err(error) => return Err(self.fail(error)),
            }
        }
        Ok(self
            .identity
            .as_ref()
            .expect("identity initialized above")
            .clone())
    }

    pub fn stats(&self) -> RangeReadStats {
        RangeReadStats {
            requests: self.requests,
            body_bytes: self.body_bytes,
            cached_bytes: self.blocks.iter().map(|(_, bytes)| bytes.len()).sum(),
        }
    }

    fn fail(&mut self, error: RangeReadError) -> io::Error {
        self.blocks.clear();
        self.failure = Some(error.clone());
        error.into_io()
    }

    fn request(
        &mut self,
        method: Method,
        identity: Option<&RangeObjectIdentity>,
        range: Option<(u64, u64)>,
    ) -> Result<Response, RangeReadError> {
        if self.requests >= self.options.max_requests {
            return Err(RangeReadError::BudgetExceeded);
        }
        if self.client.is_none() {
            self.client =
                Some(transport::client(&self.config).map_err(|_| RangeReadError::Transport)?);
        }
        let client = self.client.as_ref().expect("client initialized above");
        let mut query = Vec::new();
        if let Some(version) = identity.and_then(|identity| identity.version_id.as_ref()) {
            query.push(("versionId".to_owned(), version.clone()));
        }
        let request: RequestBuilder = if self.config.kind == "s3" {
            remote::s3_request_with_method(
                client,
                &self.credentials,
                &self.config,
                method,
                self.url.clone(),
                &query,
            )
            .map_err(|_| RangeReadError::Transport)?
        } else {
            remote::dav_request(client, &self.credentials, method, self.url.clone())
        };
        let mut request = request.header(ACCEPT_ENCODING, "identity");
        if let Some(etag) = identity.and_then(|identity| identity.etag.as_ref()) {
            request = request.header(IF_MATCH, etag);
        }
        if let Some((start, end)) = range {
            request = request.header(RANGE, format!("bytes={start}-{end}"));
        }
        self.requests += 1;
        request.send().map_err(|_| RangeReadError::Transport)
    }

    fn inspect(&mut self) -> Result<RangeObjectIdentity, RangeReadError> {
        let response = self.request(Method::HEAD, None, None)?;
        let status = response.status();
        if status == StatusCode::METHOD_NOT_ALLOWED || status == StatusCode::NOT_IMPLEMENTED {
            return self.probe(None);
        }
        if status != StatusCode::OK {
            return Err(status_error(status));
        }
        validate_encoding(response.headers())?;
        let (etag, version_id) = validators(response.headers(), self.config.kind == "s3")?;
        let length = optional_number(response.headers(), CONTENT_LENGTH)?;
        drop(response);
        if etag.is_none() && version_id.is_none() {
            return self.probe(None);
        }
        let identity = RangeObjectIdentity {
            length: length.unwrap_or(0),
            etag,
            version_id,
        };
        if length.is_some() {
            Ok(identity)
        } else {
            self.probe(Some(identity))
        }
    }

    fn probe(
        &mut self,
        hint: Option<RangeObjectIdentity>,
    ) -> Result<RangeObjectIdentity, RangeReadError> {
        if self.body_bytes >= self.options.max_bytes {
            return Err(RangeReadError::BudgetExceeded);
        }
        let response = self.request(Method::GET, hint.as_ref(), Some((0, 0)))?;
        if response.status() != StatusCode::PARTIAL_CONTENT {
            return Err(status_error(response.status()));
        }
        validate_encoding(response.headers())?;
        let (start, end, length) = content_range(response.headers())?;
        if start != 0 || end != 0 {
            return Err(RangeReadError::InvalidResponse(
                "Initial Content-Range does not match the requested byte",
            ));
        }
        let (etag, version_id) = validators(response.headers(), self.config.kind == "s3")?;
        if etag.is_none() && version_id.is_none() {
            return Err(RangeReadError::VersionUnavailable);
        }
        let identity = RangeObjectIdentity {
            length,
            etag,
            version_id,
        };
        if let Some(hint) = hint {
            check_version(&hint, &identity)?;
        }
        self.read_body(response, 1)?;
        Ok(identity)
    }

    fn read_body(
        &mut self,
        mut response: Response,
        expected: u64,
    ) -> Result<Vec<u8>, RangeReadError> {
        let declared = optional_number(response.headers(), CONTENT_LENGTH)?;
        if declared.is_some() && header(response.headers(), TRANSFER_ENCODING)?.is_some() {
            return Err(RangeReadError::InvalidResponse(
                "Ambiguous transfer encoding and content length",
            ));
        }
        if declared.is_some_and(|length| length != expected) {
            return Err(RangeReadError::InvalidResponse(
                "Content-Length differs from the requested range",
            ));
        }
        if expected > self.options.max_bytes.saturating_sub(self.body_bytes) {
            return Err(RangeReadError::BudgetExceeded);
        }
        let mut bytes = Vec::with_capacity(expected as usize);
        loop {
            if bytes.len() as u64 == expected {
                if declared.is_none() {
                    // A response without Content-Length still needs an EOF check,
                    // even when its valid payload has exactly filled the budget.
                    // Read at most one overflow sentinel, never another payload
                    // chunk; an extra byte poisons the reader and is not cached.
                    let mut sentinel = [0];
                    let count = response.read(&mut sentinel).map_err(|_| {
                        RangeReadError::InvalidResponse(
                            "Range response body was truncated or unreadable",
                        )
                    })?;
                    self.body_bytes += count as u64;
                    if count != 0 {
                        return Err(RangeReadError::InvalidResponse(
                            "Range response body exceeds its declared range",
                        ));
                    }
                }
                break;
            }
            let remaining = self.options.max_bytes.saturating_sub(self.body_bytes);
            if remaining == 0 {
                return Err(RangeReadError::BudgetExceeded);
            }
            let wanted = (expected - bytes.len() as u64).min(remaining).min(8192) as usize;
            let mut block = [0u8; 8192];
            let count = response.read(&mut block[..wanted]).map_err(|_| {
                RangeReadError::InvalidResponse("Range response body was truncated or unreadable")
            })?;
            if count == 0 {
                break;
            }
            self.body_bytes += count as u64;
            bytes.extend_from_slice(&block[..count]);
        }
        if bytes.len() as u64 != expected {
            return Err(RangeReadError::InvalidResponse(
                "Range response body is shorter than its declared range",
            ));
        }
        Ok(bytes)
    }

    fn block(
        &mut self,
        start: u64,
        identity: &RangeObjectIdentity,
    ) -> Result<Vec<u8>, RangeReadError> {
        let end = start
            .saturating_add(self.options.chunk_size as u64 - 1)
            .min(identity.length - 1);
        let expected = end - start + 1;
        if expected > self.options.max_bytes.saturating_sub(self.body_bytes) {
            return Err(RangeReadError::BudgetExceeded);
        }
        let response = self.request(Method::GET, Some(identity), Some((start, end)))?;
        if response.status() != StatusCode::PARTIAL_CONTENT {
            return Err(status_error(response.status()));
        }
        validate_encoding(response.headers())?;
        let actual = content_range(response.headers())?;
        if actual != (start, end, identity.length) {
            return Err(RangeReadError::InvalidResponse(
                "Content-Range differs from the requested range or object length",
            ));
        }
        let (etag, version_id) = validators(response.headers(), self.config.kind == "s3")?;
        check_version(
            identity,
            &RangeObjectIdentity {
                length: identity.length,
                etag,
                version_id,
            },
        )?;
        self.read_body(response, expected)
    }

    fn read_inner(
        &mut self,
        output: &mut [u8],
        identity: RangeObjectIdentity,
    ) -> Result<usize, RangeReadError> {
        if self.position >= identity.length {
            return Ok(0);
        }
        let start = self.position / self.options.chunk_size as u64 * self.options.chunk_size as u64;
        let bytes = if let Some(index) = self.blocks.iter().position(|(offset, _)| *offset == start)
        {
            self.blocks
                .remove(index)
                .expect("index from the same queue")
                .1
        } else {
            self.block(start, &identity)?
        };
        let offset = (self.position - start) as usize;
        let count = output.len().min(bytes.len() - offset);
        output[..count].copy_from_slice(&bytes[offset..offset + count]);
        self.position += count as u64;
        self.blocks.push_back((start, bytes));
        while self.blocks.len() > self.options.max_cached_chunks {
            self.blocks.pop_front();
        }
        Ok(count)
    }
}

impl Read for RemoteRangeReader {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        let identity = self.metadata()?;
        self.read_inner(output, identity)
            .map_err(|error| self.fail(error))
    }
}

impl Seek for RemoteRangeReader {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        if let Some(error) = &self.failure {
            return Err(error.clone().into_io());
        }
        let next = match position {
            SeekFrom::Start(position) => Some(position),
            SeekFrom::Current(offset) => self.position.checked_add_signed(offset),
            SeekFrom::End(offset) => self.metadata()?.length.checked_add_signed(offset),
        }
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Remote seek position is outside the u64 range",
            )
        })?;
        self.position = next;
        Ok(next)
    }
}

fn header(headers: &HeaderMap, name: HeaderName) -> Result<Option<&str>, RangeReadError> {
    let mut values = headers.get_all(&name).iter();
    let value = values.next();
    if values.next().is_some() {
        return Err(RangeReadError::InvalidResponse(
            "Duplicate response identity or length header",
        ));
    }
    value
        .map(|value| {
            value
                .to_str()
                .map_err(|_| RangeReadError::InvalidResponse("Invalid response header encoding"))
        })
        .transpose()
}

fn optional_number(headers: &HeaderMap, name: HeaderName) -> Result<Option<u64>, RangeReadError> {
    header(headers, name)?
        .map(|value| {
            if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(RangeReadError::InvalidResponse(
                    "Invalid object or response length",
                ));
            }
            value.parse().map_err(|_| {
                RangeReadError::InvalidResponse("Object or response length overflows u64")
            })
        })
        .transpose()
}

fn validators(
    headers: &HeaderMap,
    s3: bool,
) -> Result<(Option<String>, Option<String>), RangeReadError> {
    let etag = header(headers, ETAG)?
        .filter(|value| {
            value.len() >= 2
                && value.starts_with('"')
                && value.ends_with('"')
                && value.as_bytes()[1..value.len() - 1]
                    .iter()
                    .all(|byte| *byte == b'!' || (b'#'..=b'~').contains(byte))
        })
        .map(str::to_owned);
    let version = if s3 {
        header(headers, HeaderName::from_static("x-amz-version-id"))?
            .filter(|value| {
                !value.is_empty() && !value.eq_ignore_ascii_case("null") && value.len() <= 1024
            })
            .map(str::to_owned)
    } else {
        None
    };
    Ok((etag, version))
}

fn validate_encoding(headers: &HeaderMap) -> Result<(), RangeReadError> {
    if header(headers, CONTENT_ENCODING)?
        .is_some_and(|value| !value.eq_ignore_ascii_case("identity"))
    {
        return Err(RangeReadError::InvalidResponse(
            "Encoded response cannot be used as original byte ranges",
        ));
    }
    Ok(())
}

fn content_range(headers: &HeaderMap) -> Result<(u64, u64, u64), RangeReadError> {
    let value = header(headers, CONTENT_RANGE)?.ok_or(RangeReadError::InvalidResponse(
        "Range response is missing Content-Range",
    ))?;
    let (range, total) = value
        .strip_prefix("bytes ")
        .and_then(|value| value.split_once('/'))
        .ok_or(RangeReadError::InvalidResponse("Invalid Content-Range"))?;
    let (start, end) = range
        .split_once('-')
        .ok_or(RangeReadError::InvalidResponse(
            "Invalid Content-Range bounds",
        ))?;
    let number = |value: &str| -> Result<u64, RangeReadError> {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(RangeReadError::InvalidResponse(
                "Content-Range must contain numeric bounds",
            ));
        }
        value
            .parse()
            .map_err(|_| RangeReadError::InvalidResponse("Content-Range overflows u64"))
    };
    let (start, end, total) = (number(start)?, number(end)?, number(total)?);
    if start > end || end >= total {
        return Err(RangeReadError::InvalidResponse(
            "Content-Range bounds exceed the object length",
        ));
    }
    Ok((start, end, total))
}

fn check_version(
    expected: &RangeObjectIdentity,
    actual: &RangeObjectIdentity,
) -> Result<(), RangeReadError> {
    if expected
        .etag
        .as_ref()
        .is_some_and(|etag| actual.etag.as_ref() != Some(etag))
        || expected
            .version_id
            .as_ref()
            .is_some_and(|version| actual.version_id.as_ref() != Some(version))
    {
        return Err(RangeReadError::VersionChanged);
    }
    Ok(())
}

fn status_error(status: StatusCode) -> RangeReadError {
    match status {
        StatusCode::OK | StatusCode::METHOD_NOT_ALLOWED | StatusCode::NOT_IMPLEMENTED => {
            RangeReadError::Unsupported
        }
        StatusCode::PRECONDITION_FAILED => RangeReadError::VersionChanged,
        StatusCode::RANGE_NOT_SATISFIABLE => RangeReadError::InvalidResponse(
            "Server rejected a range inside the known object length",
        ),
        _ => RangeReadError::HttpStatus(status.as_u16()),
    }
}
