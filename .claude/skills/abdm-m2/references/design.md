# Design M2, create and link records

What the integration has to do to the journey around the calls: how many questions a patient is asked, where a failure is shown, and what a screen is forbidden to claim. Every rule below comes from a Catalogue atom, cited at the end.

## The unit of work is an exchange, not a call

### In plain words

Every M2 and M3 call answers twice. Once straight away, saying the request was
accepted, and later on a callback to your own bridge, saying what actually
happened. Do not treat the first as success. It says the request was accepted,
not that anything was linked.

So the request id stops being a log handle and becomes the join key. An
outbound call, the wait, and the callback that answers it are one exchange, and
they should read as one row with a timeline. Shown as three separate lines they
read as noise, and the difference between accepted and done stays invisible,
which is the one thing the interface exists to show.

### What happens

Register the waiter before sending. A callback that arrives before the HTTP
response returns is a race the sandbox eventually wins.

Then hold five outcomes apart. These must not look alike:

| State | Means | Observed |
|---|---|---|
| sent | in the air | |
| accepted, waiting | `202`, nothing back yet | real patient, 340 ms |
| answered | the callback arrived | |
| refused before waiting | a synchronous `400`, nothing was ever pending | fictional patient, 91 ms |
| no answer in the window | accepted, then silence | real patient, 60,000 ms |

The fourth and fifth are the ones implementations collapse into each other. A
refused call closing its waiter through the same function as an answered one
renders a synchronous `400` as a green callback arrived. Fix that in the shared
function rather than at the call sites that reach it.

The fourth outcome is also useful. Generate link token validates the patient
before accepting the request, so an identity nobody holds is refused at once
with `400` and `ABDM-9999`, while a recognised one is accepted with `202` and
answers later. The two are distinguishable at the first response, so only a
recognised patient is worth waiting for. Note the code: `ABDM-9999` is the catch
all, and the message is the only part naming the cause.

No timeout is published for any of these, so the honest words for the fifth
outcome are that nothing arrived in the window you chose.

### How you know it worked

Send one linking call and read one row. It carries the request id, the outbound
call, the elapsed wait, and the callback when it lands, in one timeline.

Send a call for an identity nobody holds. The row shows refused within a few
hundred milliseconds, never shows waiting, and no waiter is left open.

### When it goes wrong

- A synchronous refusal shows as a completed exchange. The refusal path and the
  callback path share the function that closes the waiter.
- A callback cannot be matched to its call. The waiter was registered after
  sending, and the callback won the race.
- Every call is accepted and nothing ever answers. No callback URL is registered
  against the facility id, which is a configuration cause for a runtime symptom.

## Nobody is standing there, so never block and never lose the state

### In plain words

M1's rules do not carry over to M2. There is no patient to spare a question, no
one time password to save, and no screen anybody is looking at. The patient has
left. What there is instead is a call that was accepted and then went quiet, and
a callback that may arrive tomorrow or never.

Two consequences follow, and they are the opposite of how an M1 journey is
built.

### What happens

**Never block.** Linking is several calls, each answered on a callback that may
be a minute away. A button that waits for the outcome is a button that hangs for
sixty seconds and then says nothing useful. Start the work, return at once, and
point at where it can be watched. The desk gets on with the next patient.

**State outlives the session.** Where a link has got to belongs on the record,
not in a page's memory. Reopening the application must show where everything
stands without re-running anything. This is the reverse of M1, where the whole
journey lives and dies inside one person's visit.

**Name the step, not the spinner.** Linking tells a receptionist nothing. These
do:

- Asking ABDM for a link token.
- Asking ABDM for a link token: ABDM accepted it and no answer came back. This
  client has no callback URL registered, so the answer has nowhere to go.
- Asking ABDM for a link token: refused. `ABDM-9999`, user not found.

The second is the interesting one. It names a configuration cause for a runtime
symptom, which is the difference between a receptionist raising a ticket and an
integrator fixing one line of configuration.

### How you know it worked

Start a link and close the page. Reopen the application and the record shows
which step the link reached, and when, without any call being made again.

Press the button that starts linking. It returns immediately and points at where
progress can be watched. It does not sit waiting for a callback.

### When it goes wrong

- The interface hangs for sixty seconds and then reports nothing. Something is
  waiting on the callback inside the request that started the work.
- Reopening the application shows a link as not started when it was started
  yesterday. The state was held in the page rather than on the record.
- A receptionist raises a ticket for what turns out to be a missing callback
  URL. The message named the symptom without naming the configuration cause.

## A refused request is still remembered, so a retry is a duplicate

### In plain words

ABDM records a link token request even when it refuses the patient, and
deduplicates the next identical request against the one it refused. So a retry
inside that window cannot succeed, and its refusal no longer names the original
cause.

The second message says duplicate, which reads as though the first attempt had
worked. It had not.

### What happens

The same request for the same unknown address, sent twice:

| When | Result |
|---|---|
| 14:17:42 | `400`, `ABDM-9999`, user not found |
| 14:18:51, 69 seconds later | `400`, `ABDM-1092`, duplicate link token request |

The length of the deduplication window is not published. It is at least sixty
nine seconds.

So do not offer a button that cannot work. Where a duplicate is the answer,
explain it, and say that the earlier refusal is the one that names the cause.
Point the reader back at the first exchange rather than at the second.

This is the reason the first refusal has to be kept rather than replaced. An
interface that overwrites the last error with the newest one destroys the only
message that explained anything.

### How you know it worked

Send a request that is refused, then send it again inside the window. The
interface shows `ABDM-1092`, does not present it as a new failure, and links
back to the first exchange and its `ABDM-9999`.

The retry control is absent or disabled while the window is open, rather than
present and failing.

### When it goes wrong

- A retry loop runs and every attempt after the first says duplicate. Nothing is
  checking whether a retry can succeed.
- The cause of a failure cannot be found because the newest message replaced it.
  Keep every exchange, and treat the first refusal as the authoritative one.
- A duplicate refusal is read as evidence that the first request succeeded.
  It is not. The first was refused, and ABDM remembered the refusal.

## What the integrator needs on screen, separately from the patient

### In plain words

A desk that talks to ABDM asynchronously cannot be debugged without a view built
for the integrator rather than the receptionist. It is cheap to build and it is
the difference between a fix that takes a minute and one that takes a day.

### What happens

**A live view of every call and callback, grouped by request id**, so an
outbound call, its wait, and the callback answering it read as one exchange with
a timeline.

**Redact by name and length, never by value.** Show that an `Authorization`
header was sent and how long it was. Never its contents. The panel is a browser.

**Show what would be sent, before sending it.** A request preview or a bundle
inspector turns it failed at the far end into something checkable at the desk.

**A readiness check that names what is missing**, and this is where two
configuration failures have to be told apart:

| Missing | Effect | Treat as |
|---|---|---|
| Facility id | the call cannot be sent | blocker, refuse locally |
| Callback URL | the call sends and is accepted, and the answer has nowhere to go | warning, send anyway |

Treating both as blockers is the tempting mistake. Refusing to send when no
callback URL is registered hides exactly the behaviour the panel exists to make
visible. Send, accept, wait, time out, and say why.

Refuse the first locally and name the value. An invented facility id comes back
from ABDM as an entitlement error that reads like a credentials problem, and
sends the integrator to the console instead of to one line of configuration.

Presence is not validity. `X-HIU-ID` is checked for presence rather than
against any registry: absent is refused `401`, and an invented id is accepted
`202`. Anyone testing with a made up id sees acknowledgements that look like
progress, which is why the local check has to be the strict one.

### How you know it worked

Clear the facility id and press the button. The call is refused before anything
is sent, and the message names the configuration value that is absent.

Clear the callback URL and press the same button. The call is sent, accepted,
waits the window, and reports that nothing arrived and why.

Open the panel during a linking run. Each exchange is one row, headers are shown
by name and length, and no header value appears anywhere.

### When it goes wrong

- A token appears in the panel. Redaction is by value rather than by name and
  length. This is a credential leak, not a display bug.
- An integrator is sent to the developer console by an entitlement error. The
  facility id was not checked locally before the call went out.
- Calls are accepted and nothing ever answers, and the panel says only waiting.
  Name the missing callback URL as the cause, rather than leaving the reader
  with a timeout.

## Inbound is a surface, and silence there is a failure state

### In plain words

M2 and M3 are not only things your desk asks ABDM. ABDM asks your desk things
and waits: a discovery request, a link initiation, a link confirmation, a
request for the records a consent covers, and a consent notification.

Four of those five carry no documented payload in the published sources. A
handler written against an assumed shape fails on the first real delivery,
asynchronously, where nobody is watching. And a handler that only logs leaves a
patient's records undiscoverable while appearing to work.

### What happens

Answer the transport quickly and reason afterwards. ABDM is waiting on a `2xx`,
and a handler that thinks before it replies is a handler that times out.

Then give the interface a state for ABDM asked and this desk has not replied.
Not an empty list, and not silence. A named, visible condition, saying what a
correct reply would have been.

Where the payload is undocumented, record the entire body and the entire header
set on the first delivery of each path, before anything tries to read it.
Record header names and lengths, never values. The name is the finding. The
value is a credential.

Every inbound callback carries a bearer token in the `Authorization` header, as
`Bearer <token>`. Verify it before your handler does any work. See
[proving a callback came from ABDM](/docs/hiecm/v3/concepts/callback-authenticity).

The security rule underneath: a URL reachable by ABDM is reachable by everyone.
A presented signature that fails verification is refused everywhere. An absent
one may be tolerated on a sandbox, and where it is, the record has to be marked
as unverified rather than passed off as genuine.

### How you know it worked

Trigger a discovery against your bridge. The transport is acknowledged inside
the window, and the interface shows the delivery, the reply, and the time
between them.

Take a path you have never received before. The whole body and the whole header
name set are recorded before any code reads a field, so the shape can be learned
from the record rather than guessed.

Leave an inbound request unanswered on purpose. The interface names it as
unanswered rather than showing nothing.

### When it goes wrong

- A patient's records cannot be found from another facility, and nothing looks
  broken. A discovery handler is logging and not replying.
- Deliveries time out under load. Work is being done before the acknowledgement
  rather than after it.
- A handler throws on the first real delivery. It was written against an assumed
  payload, and the body was never recorded whole.

## A care context and its records are one thing

### In plain words

A care context is the visit. The records are what happened at it. Neither is
useful alone.

A bundle nobody can name a care context for cannot be sent. A care context with
nothing behind it is a promise the next discovery cannot keep: another facility
finds the visit, asks for the records, and there are none.

So store them together and show them together.

### What happens

Show the counts that matter to a patient rather than the ones that are easy to
compute: visits opened, documents attached, and visits not yet findable
elsewhere. The third is the one worth surfacing, because it means a record
exists that no other facility can reach.

Validate before storing, not before sending. Refusing to store a bundle the
receiver could not read is cheap. Discovering it after a consent has been served
is not.

Let the desk inspect a bundle before it goes: the profile it claims, the
resources inside it, the attachment type, and whether every reference resolves
within the bundle. The upload itself wants a drop target, a title prefilled from
the filename but editable, and named refusals for type and for size. Show a hash
and a size so a file is identifiable in a list without keeping a second copy of
it.

Write the title for the patient. They read it in their own application months
later, not the receptionist filing it today.

Never log the attachment. It is a patient's record, and it belongs in the bundle
and in the encrypted payload built from it, nowhere else.

### How you know it worked

Open a visit and attach nothing. The interface counts it as a visit not yet
findable elsewhere, rather than as a completed link.

Attach a document and the same count falls by one.

Try to store a bundle whose references do not resolve inside it. Storing is
refused, and the refusal names the reference that pointed outward.

### When it goes wrong

- Another facility discovers a visit and receives nothing. A care context was
  linked with no records behind it.
- A bundle is refused at the far end, asynchronously, with no explanation
  reaching the desk. It was validated before sending rather than before storing.
- A list of visits becomes slow to open. Bundles are being held in the list
  rather than stored separately and read when needed.

## Asynchronous calls and callbacks, why a 200 means very little

### In plain words

Nothing goes participant to participant. Every request is addressed to the gateway, which forwards it. Two things follow.

- **You get an acknowledgement, not an answer.** In the [M3](/docs/hiecm/v3/getting-started/glossary#m3) consent flow the [HIU](/docs/hiecm/v3/getting-started/glossary#hiu) asks, the HIE-CM returns the consent request id on a callback, and the patient's decision comes back later. Each call's page in the [API reference](/docs/hiecm/v3/api) names the callback it produces.
- **You have to be reachable.** Half of [M2](/docs/hiecm/v3/getting-started/glossary#m2) is endpoints the gateway calls on your system.

One exception. In the health information flow the HIU supplies a data push URL, and the HIP encrypts the records and pushes them there. That URL may differ from the HIU's registered gateway URL, to improve privacy. The permission came through the gateway. The bytes do not.

Match each callback to the call that caused it by `response.requestId`, which carries the `REQUEST-ID` you sent. Callbacks do not arrive in the order you sent the requests, and the same one can arrive twice, so a repeat must change nothing. Each callback is described in [the API reference](/docs/hiecm/v3/api).

### What happens

Send the call with a fresh `REQUEST-ID`, treat the 202 as receipt only, and wait for the callback. Key the handler on `response.requestId`, answer it quickly, and make a second delivery of the same request id a no-op.

### How you know it worked

A callback reaches your URL whose `response.requestId` equals the `REQUEST-ID` you sent. Given three calls and two callbacks, the call whose request id has no callback is the one outstanding.

### When it goes wrong

Nothing arrives: work through [the callback never arrives](/docs/hiecm/v3/troubleshooting/callback-never-arrives). A retry is appended as a new event: key on the request id. The code waits on the response body for the result: it never comes there, so the integration hangs.

## Proving a callback really came from ABDM

### In plain words

Every callback in the specifications declares bearer authentication. The token
arrives in the `Authorization` header as `Bearer <token>`. Check three things
before your handler does any work:

1. **A bearer token is present.** Reject a callback without one, and log the
   rejection.
2. **An answer answers a call you made.** Its `response.requestId` matches the
   `REQUEST-ID` of a request you sent. A callback that answers nothing you sent
   is not yours to act on.
3. **It is for a facility you serve.** `X-HIP-ID` or `X-HIU-ID` names one of
   your own facilities. This is the only check that covers a callback that
   answers nothing, such as a discovery request, a link init or a consent
   notification. A bridge can receive callbacks for services that are not
   yours: on a shared sandbox bridge, another organisation's consent
   notifications and link callbacks have arrived at an integrator's URL.
   Storing one keeps another organisation's patient data, and answering one
   acts on its behalf.

The keys that verify the token's signature are not among the published gateway
calls. Confirm at onboarding how to verify the token, and meanwhile hold the
three checks above.

The signature inside a consent artefact is a different thing. It signs the
artefact's contents and proves the artefact was not altered. Checking the
delivery does not check the artefact, and checking the artefact does not check
the delivery.

### How you know it worked

A callback carrying a bearer token and a request id you sent is processed. The
same body with the `Authorization` header removed is rejected before your
handler reads the payload, and the rejection is logged. The second is the test
worth writing, because it is the only one that fails loudly when the check is
silently skipped.

### When it goes wrong

**The check is skipped under load.** A handler that checks inside a try block
and continues on failure is worse than one that never checked, because it reads
as safe. Fail closed.

**Nothing arrives at all**, which is a different problem. See
[the callback never arrives](/docs/hiecm/v3/troubleshooting/callback-never-arrives).

### What happens

In the handler, before parsing the body for action: require the `Authorization` header with a bearer token; require that `X-HIP-ID` or `X-HIU-ID` names one of your facilities; and, on a callback that answers a call, require that `response.requestId` matches a `REQUEST-ID` your system sent and has not already handled. Reject otherwise. Do not invent a signature check against a key source the specifications do not publish.

### How you know it worked

A test posts a valid callback body without `Authorization` and sees it rejected and logged before any handler work.

### When it goes wrong

Never fall back to processing a callback that failed a check while you investigate. A callback whose request id is unknown to you, or whose facility header names a facility you do not serve, is logged and dropped, not stored, answered or retried.

## Care contexts, how records are grouped so they can be found

### In plain words

Each care context contains only two pieces of information:

- **Reference ID.** A unique internal identifier assigned by the
  [HRP](/docs/hiecm/v3/getting-started/glossary#hrp) (HMIS/LMIS). Used to link
  and retrieve the associated health records.
- **Display Name.** A user-friendly description to help identify the group of
  records. Must not include any sensitive or confidential information such as
  test results or diagnoses. Example: "OPD records (X-Ray, Prescription) from
  3rd March 2023".

### Recommended approach for structuring care contexts

To ensure clarity and usability, it is recommended to organise patient data as
follows:

- Create one care context per outpatient visit (OPD)
- Create one care context per inpatient admission (IPD)

This approach provides a clear and event-based grouping of health records.

### JSON structure of care contexts

```json
{
  "patient": {
    "referenceNumber": "TMH-PUID-001",
    "display": "TMH records for Kiran Kumar",
    "careContexts": [
      {
        "referenceNumber": "2375639",
        "display": "OPD records for 03 Oct 2022"
      }
    ]
  }
}
```

### What happens

Give each care context a `referenceNumber` your own system resolves to the records behind it, and a `display` a person recognises months later. Group by encounter: one per outpatient visit, one per inpatient admission, not one per test or document.

### How you know it worked

Three tests in one visit are one care context. A display name reads like "OPD records for 03 Oct 2022" and carries no diagnosis or result.

### When it goes wrong

A diagnosis or result in `display` leaks clinical information into a system built never to hold it, visible to anyone who can list the patient's care contexts. One care context per record produces a list no person can navigate.

## How a health record is encrypted between HIP and HIU

### In plain words

The scheme is [Elliptic Curve Diffie-Hellman](/docs/hiecm/v3/getting-started/glossary#ecdh) key exchange on Curve25519, with AES-GCM for the payload and HKDF to derive the session key. Only the HIU holding valid consent can read the data, and the design gives perfect forward secrecy: key material compromised later does not expose data exchanged earlier.

### Who holds which key

| Key material | Generated by | Where it goes |
| --- | --- | --- |
| Short term private key, DHSK(U) | HIU | Never leaves the HIU |
| Short term public key, DHPK(U) | HIU | Sent with the request |
| Nonce, RAND(U), 32 bytes | HIU | Sent with the request |
| Short term private key, DHSK(P) | HIP | Never leaves the HIP |
| Short term public key, DHPK(P) | HIP | Sent with the encrypted data |
| Nonce, RAND(P), 32 bytes | HIP | Sent with the encrypted data |
| Shared key, DHK(U,P) | Computed independently by both | Never transmitted |
| Session key, SK(U,P), 256 bit AES-GCM | Derived independently by both | Never transmitted |
| Long term private key | HIP | Never leaves the HIP. Signs the encrypted payload. |

A new key pair per exchange is what buys forward secrecy.

### What the HIP does, step by step

Six steps, once consent has validated.

1. Generate a key pair, DHSK(P) and DHPK(P), in the group the HIU specified.
2. Generate a 32 byte random value, RAND(P).
3. Compute the shared key DHK(U,P) from the HIU's public key DHPK(U) and the HIP's own private key DHSK(P).
4. Derive the salt and IV by XOR of RAND(P) and RAND(U). The first 20 bytes are the salt for HKDF, the last 12 bytes the IV.
5. Compute a 256 bit AES-GCM session key SK(U,P) with HKDF-SHA256, from the x coordinate of the shared key and that salt. The HKDF `info` is empty.
6. Encrypt the data with AES-256-GCM, that key and that IV, with no additional authenticated data. Append the 16 byte authentication tag to the ciphertext and base64 encode the result.

The HIP then sends DHPK(P), RAND(P) and the encrypted data. The HIU derives the same session key from its own private key DHSK(U) and the HIP's public key DHPK(P), with salt and IV from the same XOR.

Build the shared key from the HIU's public key and the HIP's private key. That is the pairing that makes the Diffie-Hellman exchange work.

### Do not write this yourself

Two reference implementations exist. Fidelius, at [github.com/sukreet/fidelius](https://github.com/sukreet/fidelius), and the Fidelius CLI, which is Java, with worked examples for Node.js, Python, Ruby and PHP at [github.com/mgrmtech/fidelius-cli](https://github.com/mgrmtech/fidelius-cli/tree/main/examples) that run the binary as a subprocess. A webinar covers the CLI from both sides, at [youtu.be/rSir2gbkEmk](https://youtu.be/rSir2gbkEmk?t=9232) from 2:33:52.

### What happens

Generate a fresh key pair and nonce per transfer. XOR the two nonces: the first 20 bytes are the HKDF salt, the last 12 the IV. Derive the key with HKDF-SHA256 over the x coordinate of the ECDH result, with an empty `info`, for 32 bytes. Encrypt with AES-256-GCM, no additional authenticated data, and append the 16 byte tag before base64 encoding.

### How you know it worked

The HIU decrypts every entry and its tag check passes. Before any peer is involved, round trip a record through the Fidelius CLI and compare bytes.

### When it goes wrong

Every tag check fails: compare the salt and IV split, the HKDF input (the x coordinate, not the whole shared secret) and an `info` or additional data that should be empty. One HIP fails while others work: compare how its public key is encoded.

## Reading an ABDM error code

### In plain words

ABDM returns [several different error shapes](/docs/hiecm/v3/api/m1/errors), and
only some of them carry a code. Parse for all of them before you write any handling,
because the shape tells you where the failure came from.

Every code in the [error code reference](/docs/hiecm/v3/reference/error-codes)
carries an action. Key your handling to that column rather than to a list of
codes you maintain by hand.

| Action | What your code does |
| --- | --- |
| Fix request | Do not retry. Something you sent is wrong, and sending it again will not help |
| Fix auth | Fetch a fresh token, then retry once |
| New request id | Generate a new `REQUEST-ID`, then retry once |
| Retry | Back off and retry, with a ceiling on attempts |
| Cannot proceed | Stop, and tell the person why in their own terms |
| Ask support | Stop, and collect the ids before the context is lost |
| Unclassified | Treat as Cannot proceed until you have seen it once and know better |

Symptom first debugging, for the failures that produce no useful code at all, is
in [troubleshooting](/docs/hiecm/v3/troubleshooting).

Read the code in the body before the HTTP status. A 404 can carry `ABDM-1016`,
Invalid Timestamp: the route exists and the request was refused. A 404 whose
body carries `Status report` and no code means no route matched the request. A
code can arrive bare or with a trailing colon and space, as in `ABDM-1016: `, so
match on the code itself.

### What happens

Parse the body for an error code before acting on the status. Strip a trailing colon and space from the code, then key the handling on the action column of the [error code reference](/docs/hiecm/v3/reference/error-codes), not on a list maintained by hand.

### How you know it worked

Given a code, you can say what it means and which header or field it concerns: `ABDM-2403` is Invalid X-CM-ID, the consent manager header.

### When it goes wrong

A one line message is read as a diagnosis: Invalid header covers many causes. A code that is not in the reference is handled as Unclassified, not guessed at. A 404 is treated as a wrong path when its body carries a code.

## Roles, which entity your software acts for and which way the record moves

### In plain words

There are two integrator roles on HIE-CM, and your product is one of them for its
whole life. What decides it is which entity your software acts for.

| Role | It acts for | What you build |
| --- | --- | --- |
| [IMS](/docs/hiecm/v3/getting-started/glossary#ims) | A care provider. An HMIS in a hospital, an EMR in a clinic, a LIMS in a laboratory, a PMS in a pharmacy | [M1](/docs/hiecm/v3/milestones/m1) to [M4](/docs/hiecm/v3/milestones/m4) |
| [PHR](/docs/hiecm/v3/getting-started/glossary#phr) | A care seeker, who holds their own records and gives consent | [P1](/docs/hiecm/v3/milestones/p1) to [P3](/docs/hiecm/v3/milestones/p3) |

[HIP](/docs/hiecm/v3/getting-started/glossary#hip) and
[HIU](/docs/hiecm/v3/getting-started/glossary#hiu) are not a third and a fourth
role, and they are not something you register as. They are the two ends of one
record moving: whoever publishes it is the HIP for that exchange, and whoever
asks to read one they did not create is the HIU.

Both roles are both, and it changes call by call:

- A hospital is the HIP when it shares a discharge summary, and the HIU when it pulls an earlier prescription, through the same IMS.
- A citizen is the HIP when they push a record from their PHR application, and the HIU when they fetch one.

Neither is a thing you can build once and be. See
[HIP and HIU](/docs/hiecm/v3/concepts/hip-hiu).

So the milestones you build follow the direction your records move, not the kind
of product you sell. A PHR app that lets a citizen push a record publishes as
the HIP, and builds the M2 linking and transfer calls as well. See
[where the citizen is the HIP](/docs/hiecm/v3/milestones/p2#where-the-citizen-is-the-hip).
Records never pass through the consent manager: it routes the request and holds
the consent, and the record goes from the system that holds it to the system
that asked.

### What happens

Decide the role once, IMS or PHR, from the entity. Then list every direction a record moves through the product: publishing a record is HIP behaviour, fetching one it did not create is HIU behaviour. Build the milestones for each direction the product uses.

### How you know it worked

For a hospital system that also pulls a patient's history, you can name the role, IMS, both directions, and the milestones: M1, M2 and M3. For a PHR app that uploads a scanned prescription, you can say the citizen is the HIP for that record.

### When it goes wrong

HIP, HIU, health repository and health locker are chosen as though they were one list of company types: two are directions, one is custody, one is a product. A PHR app is built for P1 alone and then cannot publish the first record a citizen pushes. A fetch is designed against the consent manager, which holds no records.

## Where these came from

- `hiecm.concept.m2-exchange-not-call`
- `hiecm.concept.m2-never-block-the-desk`
- `hiecm.concept.m2-retry-is-a-duplicate`
- `hiecm.concept.m2-integrator-call-panel`
- `hiecm.concept.m2-inbound-is-a-surface`
- `hiecm.concept.m2-care-context-and-records`
- `hiecm.concept.asynchronous-callbacks`
- `hiecm.concept.callback-authenticity`
- `hiecm.concept.care-context`
- `hiecm.concept.data-flow-encryption`
- `hiecm.concept.error-codes`
- `hiecm.concept.roles`
