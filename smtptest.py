import smtplib, time
host = "inbound-smtp.us-east-1.amazonaws.com"
to = "fluid@flow.ufirst.co"
msg = (
    "From: Diagnostic Test <diag@example.com>\r\n"
    f"To: {to}\r\n"
    "Subject: SMTP receiving test\r\n"
    "Date: " + time.strftime("%a, %d %b %Y %H:%M:%S +0000", time.gmtime()) + "\r\n"
    "Message-ID: <diag-%d@example.com>\r\n" % int(time.time()) +
    "MIME-Version: 1.0\r\n"
    "Content-Type: text/plain; charset=utf-8\r\n"
    "\r\n"
    "This is a diagnostic SMTP test from the setup assistant.\r\n"
)
try:
    s = smtplib.SMTP(host, 25, timeout=25)
    s.set_debuglevel(1)
    code, resp = s.ehlo("flow.ufirst.co")
    print("EHLO:", code, resp)
    code, resp = s.mail("diag@example.com")
    print("MAIL FROM:", code, resp)
    code, resp = s.rcpt(to)
    print("RCPT TO:", code, resp)
    if code == 250:
        code, resp = s.data(msg)
        print("DATA:", code, resp)
    s.quit()
except Exception as e:
    print("ERROR:", type(e).__name__, e)
