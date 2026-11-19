/**
 * Azure SQL keeps UTC, so a datetime the database stamped itself (a GETDATE() default) holds the UTC
 * clock, and the driver reads every datetime as this process's clock (IST; TypeORM sets useUTC
 * false): such a value comes back 5h30 early. This gives back the instant it was stamped. A time the
 * app wrote from JS is IST already and must not go through it.
 */
export const fromDbClock = (d: Date): Date =>
    new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()));

/**
 * When a prescription was issued, as read from its row: its Date, which only the database stamps
 * (a GETDATE() default the app never writes), corrected; else its CreatedAt as stored. The clinic's
 * prescription PDF prints this as "Issued" and "Signed", and the ABDM record carries the same time.
 */
export const prescriptionIssuedAt = (row: { Date?: Date | string | null; CreatedAt?: Date | string | null }): Date | undefined =>
    row.Date ? fromDbClock(new Date(row.Date)) : row.CreatedAt ? new Date(row.CreatedAt) : undefined;
