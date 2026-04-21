/**
 * Utility for password generation and management.
 */

/**
 * Generates a random temporary password.
 * @param length The number of random characters to include (default 8).
 * @returns A string starting with 'CX' followed by random characters and a special character.
 */
export const generateTemporaryPassword = (length: number = 6): string => {
    const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const lowercase = "abcdefghijklmnopqrstuvwxyz";
    const numbers = "0123456789";
    const special = "!@#$%^&*";
    
    const all = uppercase + lowercase + numbers + special;
    
    let password = "CX"; // Prefix
    
    // Ensure at least one of each for better strength
    password += uppercase.charAt(Math.floor(Math.random() * uppercase.length));
    password += lowercase.charAt(Math.floor(Math.random() * lowercase.length));
    password += numbers.charAt(Math.floor(Math.random() * numbers.length));
    password += special.charAt(Math.floor(Math.random() * special.length));
    
    // Fill the rest
    for (let i = 0; i < length - 4; i++) {
        password += all.charAt(Math.floor(Math.random() * all.length));
    }
    
    // Shuffle the characters (optional but better)
    return password;
};
