# Security policy

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button (Security tab), not in a
public issue. Expect a reply within a week.

In scope: SSRF bypasses (reaching private, loopback, link-local or metadata addresses), token bypass, crashes from a
crafted request or page, and secrets appearing in output or logs.

Design notes: the service is meant to sit on localhost or a private network behind its bearer token. Target URLs are
checked before every request, after every redirect and after Firecrawl rendering. The Firecrawl key is read from a
file and never returned.
