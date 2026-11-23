// Proves that someone sent an email, without showing the email.
//
// A mail provider signs every email it sends (DKIM). Given such an email, this shows that:
//   - the provider's key signed it;
//   - its body carries the line `signHash <number> Code <code>`, inside the block a Passport email marks for it;
// and gives out only:
//   - which key signed, and the domain of the sender's address, so that a contract can check the key is that
//     provider's;
//   - a stand-in for the sender's address: a hash of the address and the code, which reveals neither;
//   - the number, which is what the email approves;
//   - a value unique to the email, so that it cannot be used twice;
//   - when the provider signed it.
//
// The email itself, the address and the code stay with whoever makes the proof.
use std::hash::pedersen_hash;
use zkemail::{
    dkim::RSAPubkey,
    headers::{body_hash::get_body_hash, email_address::get_email_address},
    KEY_LIMBS_2048, MAX_EMAIL_ADDRESS_LENGTH,
    partial_hash::partial_sha256_var_end,
    remove_soft_line_breaks::remove_soft_line_breaks,
    Sequence,
};

// The signed part of the header, and the end of the body that is hashed inside the proof. A body is hashed from
// its start outside the proof up to the last 64-byte boundary before the command, so its length does not matter.
global MAX_HEADER_LENGTH: u32 = 1024;
global MAX_BODY_LENGTH: u32 = 1024;

// A number of up to 78 digits covers every 32-byte value. The code is 64 hex characters.
global MAX_DIGITS: u32 = 78;
global CODE_LENGTH: u32 = 64;
global TIMESTAMP_DIGITS: u32 = 10;
// A domain of up to 62 characters, given out as two numbers of 31 characters each.
global MAX_DOMAIN_LENGTH: u32 = 62;

fn main(
    header: BoundedVec<u8, MAX_HEADER_LENGTH>,
    // The end of the body as it was sent, and the same with the line breaks mail programs add taken out.
    body: BoundedVec<u8, MAX_BODY_LENGTH>,
    decoded_body: [u8; MAX_BODY_LENGTH],
    pubkey: RSAPubkey<KEY_LIMBS_2048>,
    signature: [Field; KEY_LIMBS_2048],
    // Where things are. The prover says, and the checks below hold it to the truth.
    dkim_header_sequence: Sequence,
    body_hash_index: u32,
    timestamp_index: u32,
    partial_body_hash: [u32; 8],
    partial_body_real_length: u64,
    from_header_sequence: Sequence,
    from_address_sequence: Sequence,
    at_index: u32,
    command_index: u32,
    digits: u32,
) -> pub [Field; 7] {
    // The provider's key signed this header.
    let _ = pubkey.verify_dkim_signature(header, signature);

    // The header commits to the body by its hash, so the body shown here is the one that was sent.
    let signed_body_hash = get_body_hash(header, dkim_header_sequence, body_hash_index);
    let computed_body_hash = partial_sha256_var_end(
        partial_body_hash,
        body.storage(),
        body.len() as u64,
        partial_body_real_length,
    );
    assert(signed_body_hash == computed_body_hash, "The body is not the one the header was signed with");
    assert(
        remove_soft_line_breaks(body.storage(), decoded_body),
        "The decoded body is not the body with its soft line breaks removed",
    );

    let from = comptime { "from".as_bytes() };
    let address = get_email_address(header, from_header_sequence, from_address_sequence, from);

    let (number, code) = read_command(decoded_body, command_index, digits);
    let timestamp = read_timestamp(header, dkim_header_sequence, timestamp_index);
    let domain = read_domain(address, at_index);

    [
        // The hash of the key's modulus, which is what identifies the key.
        pubkey.hash()[0],
        domain[0],
        domain[1],
        email_id(address, code),
        number,
        pedersen_hash(signature),
        timestamp,
    ]
}

/// The stand-in for an address: a hash of the address and the code its emails carry.
fn email_id(address: BoundedVec<u8, MAX_EMAIL_ADDRESS_LENGTH>, code: Field) -> Field {
    // 320 characters, 31 to a number.
    let mut packed: [Field; 13] = [0; 13];
    let storage = address.storage();
    for i in 0..MAX_EMAIL_ADDRESS_LENGTH {
        let mut shift: Field = 1;
        for _ in 0..(i % 31) {
            shift *= 256;
        }
        packed[i / 31] += (storage[i] as Field) * shift;
    }
    packed[11] = address.len() as Field;
    packed[12] = code;
    pedersen_hash(packed)
}

/// Reads `zkemail">signHash <number> Code <code></div>` at `command_index`, where `signHash` starts.
/// The number comes back as it is modulo the field these proofs work in, which is all a checker needs: finding
/// another number that agrees with it there is as hard as breaking the hash it stands for.
fn read_command(body: [u8; MAX_BODY_LENGTH], command_index: u32, digits: u32) -> (Field, Field) {
    assert((digits != 0) & (digits <= MAX_DIGITS), "The number has no digits, or too many");
    assert(command_index >= 9, "The command is not inside the marked block");
    assert(command_index + 9 + digits + 6 + CODE_LENGTH + 6 <= MAX_BODY_LENGTH, "The command runs past the body");

    // The block a Passport email marks for the command, then the word.
    expect(body, command_index - 9, comptime { "zkemail\">".as_bytes() });
    expect(body, command_index, comptime { "signHash ".as_bytes() });

    let mut number: Field = 0;
    for i in 0..MAX_DIGITS {
        if i < digits {
            let character = body[command_index + 9 + i];
            assert((character >= 48) & (character <= 57), "The number has a character that is not a digit");
            number = number * 10 + (character - 48) as Field;
        }
    }

    let code_index = command_index + 9 + digits;
    expect(body, code_index, comptime { " Code ".as_bytes() });
    let mut code: Field = 0;
    for i in 0..CODE_LENGTH {
        let character = body[code_index + 6 + i];
        let is_digit = (character >= 48) & (character <= 57);
        let is_letter = (character >= 97) & (character <= 102);
        assert(is_digit | is_letter, "The code has a character that is not a hex digit");
        let value = if is_digit { character - 48 } else { character - 87 };
        code = code * 16 + value as Field;
    }
    expect(body, code_index + 6 + CODE_LENGTH, comptime { "</div>".as_bytes() });

    (number, code)
}

/// Reads the time the provider put in its signature: the ten digits after `; t=`.
fn read_timestamp(
    header: BoundedVec<u8, MAX_HEADER_LENGTH>,
    dkim_header_sequence: Sequence,
    timestamp_index: u32,
) -> Field {
    // `get_body_hash` has already held the sequence to be the signature's own header field.
    assert(
        (timestamp_index >= dkim_header_sequence.index + 4)
            & (timestamp_index + TIMESTAMP_DIGITS < dkim_header_sequence.end_index()),
        "The timestamp is not inside the signature's header field",
    );
    let storage = header.storage();
    expect(storage, timestamp_index - 4, comptime { "; t=".as_bytes() });
    let mut timestamp: Field = 0;
    for i in 0..TIMESTAMP_DIGITS {
        let character = storage[timestamp_index + i];
        assert((character >= 48) & (character <= 57), "The timestamp has a character that is not a digit");
        timestamp = timestamp * 10 + (character - 48) as Field;
    }
    assert(storage[timestamp_index + TIMESTAMP_DIGITS] == 59, "The timestamp does not end where it should");
    timestamp
}

/// The part of the address after its `@`, as two numbers of up to 31 characters each.
fn read_domain(address: BoundedVec<u8, MAX_EMAIL_ADDRESS_LENGTH>, at_index: u32) -> [Field; 2] {
    let length = address.len();
    assert(at_index + 1 < length, "The address has no domain");
    assert(length - at_index - 1 <= MAX_DOMAIN_LENGTH, "The domain is too long");
    let storage = address.storage();
    assert(storage[at_index] == 64, "That is not where the address has its @");

    let mut domain: [Field; 2] = [0; 2];
    let mut shift: [Field; 2] = [1; 2];
    for i in 0..MAX_DOMAIN_LENGTH {
        let index = at_index + 1 + i;
        if index < length {
            let character = storage[index];
            // One @ only, so that the domain is the whole of what follows it.
            assert(character != 64, "The address has a second @");
            domain[i / 31] += (character as Field) * shift[i / 31];
            shift[i / 31] *= 256;
        }
    }
    domain
}

/// Holds `text[index..]` to start with `expected`.
fn expect<let N: u32, let M: u32>(text: [u8; N], index: u32, expected: [u8; M]) {
    for i in 0..M {
        assert(text[index + i] == expected[i], "The email does not read as expected here");
    }
}
