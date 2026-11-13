"""SMTP TLS must authenticate the relay before credentials or mail are sent."""
import smtplib
import ssl
from unittest.mock import Mock

import pytest

from app.config import settings
from app.services import notifications


@pytest.fixture
def relay(monkeypatch):
    for name, value in {"SMTP_HOST": "relay.example.test", "SMTP_PORT": 587,
                        "SMTP_USER": "disposable-test-user", "SMTP_PASSWORD": "disposable-test-value",
                        "MAIL_DEV_DUMP_DIR": None}.items():
        monkeypatch.setattr(settings, name, value)
    client = Mock()
    plain, secure = Mock(return_value=client), Mock(return_value=client)
    monkeypatch.setattr(notifications.smtplib, "SMTP", plain)
    monkeypatch.setattr(notifications.smtplib, "SMTP_SSL", secure)
    return client, plain, secure


@pytest.mark.parametrize("implicit", [False, True], ids=["STARTTLS", "implicit-TLS"])
def test_both_smtp_tls_modes_verify_certificate_and_hostname(monkeypatch, relay, implicit):
    client, plain, secure = relay
    monkeypatch.setattr(settings, "SMTP_SSL", implicit)
    monkeypatch.setattr(settings, "SMTP_STARTTLS", not implicit)
    notifications.send_email("recipient@example.test", "subject", "body")

    if implicit:
        context = secure.call_args.kwargs["context"]
        plain.assert_not_called()
        client.starttls.assert_not_called()
    else:
        context = client.starttls.call_args.kwargs["context"]
        secure.assert_not_called()
        calls = [call[0] for call in client.method_calls]
        assert calls.index("starttls") < calls.index("login") < calls.index("send_message")
    assert isinstance(context, ssl.SSLContext)
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.check_hostname is True
    client.login.assert_called_once()
    client.send_message.assert_called_once()


@pytest.mark.parametrize("implicit", [False, True], ids=["STARTTLS", "implicit-TLS"])
@pytest.mark.parametrize("failure", [ssl.SSLCertVerificationError, ssl.SSLError])
def test_tls_failure_never_authenticates_or_sends(monkeypatch, relay, implicit, failure):
    client, plain, secure = relay
    monkeypatch.setattr(settings, "SMTP_SSL", implicit)
    monkeypatch.setattr(settings, "SMTP_STARTTLS", not implicit)
    if implicit:
        secure.side_effect = failure("synthetic TLS handshake failure")
    else:
        client.starttls.side_effect = failure("synthetic TLS handshake failure")
    with pytest.raises(failure):
        notifications.send_email("recipient@example.test", "subject", "body")
    client.login.assert_not_called()
    client.send_message.assert_not_called()
    if implicit:
        plain.assert_not_called()
    else:
        client.quit.assert_called_once()


def test_missing_starttls_support_does_not_fall_back_to_plaintext(monkeypatch, relay):
    client, _, _ = relay
    monkeypatch.setattr(settings, "SMTP_SSL", False)
    monkeypatch.setattr(settings, "SMTP_STARTTLS", True)
    client.starttls.side_effect = smtplib.SMTPNotSupportedError("synthetic relay has no STARTTLS")
    with pytest.raises(smtplib.SMTPNotSupportedError):
        notifications.send_email("recipient@example.test", "subject", "body")
    client.login.assert_not_called()
    client.send_message.assert_not_called()
