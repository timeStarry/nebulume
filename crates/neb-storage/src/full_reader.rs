//! Lazy full-body connection snapshot, suitable for use outside registry locks.
use crate::{remote, transport, Credentials, StorageConfig};
use reqwest::blocking::{Client, Response};
use std::io::{self, Read};

pub(crate) struct RemoteStreamReader {
    client: Option<Client>,
    config: StorageConfig,
    credentials: Credentials,
    key: String,
    response: Option<Response>,
    failed: bool,
}

impl RemoteStreamReader {
    pub(crate) fn new(
        client: Option<Client>,
        config: StorageConfig,
        credentials: Credentials,
        key: String,
    ) -> Self {
        Self {
            client,
            config,
            credentials,
            key,
            response: None,
            failed: false,
        }
    }

    fn start(&mut self) -> io::Result<()> {
        let result = (|| -> anyhow::Result<Response> {
            if self.client.is_none() {
                self.client = Some(transport::client(&self.config)?);
            }
            remote::read_response(
                self.client.as_ref().expect("client initialized above"),
                &self.config,
                &self.credentials,
                &self.key,
            )
        })();
        match result {
            Ok(response) => {
                self.response = Some(response);
                Ok(())
            }
            Err(_) => {
                self.failed = true;
                Err(io::Error::other(
                    "Remote file request failed; check the connection and access permissions",
                ))
            }
        }
    }
}

impl Read for RemoteStreamReader {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        if self.failed {
            return Err(io::Error::other(
                "Remote file reader failed; create a new request to retry",
            ));
        }
        if self.response.is_none() {
            self.start()?;
        }
        match self
            .response
            .as_mut()
            .expect("response initialized above")
            .read(output)
        {
            Ok(count) => Ok(count),
            Err(_) => {
                self.failed = true;
                Err(io::Error::other("Remote file response was interrupted"))
            }
        }
    }
}
