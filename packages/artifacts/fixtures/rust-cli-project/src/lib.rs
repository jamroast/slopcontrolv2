//! packetd — tiny packet parser used as a Rust pilot fixture.

/// One parsed packet: a tag and its payload bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Packet {
    pub tag: String,
    pub payload: Vec<u8>,
}

/// Parse `TAG:payload` into a [`Packet`]; empty payload is allowed.
pub fn parse_packet(input: &str) -> Result<Packet, String> {
    let (tag, payload) = input
        .split_once(':')
        .ok_or_else(|| format!("malformed packet (missing ':'): {input:?}"))?;
    if tag.is_empty() {
        return Err(format!("malformed packet (empty tag): {input:?}"));
    }
    Ok(Packet {
        tag: tag.to_string(),
        payload: payload.as_bytes().to_vec(),
    })
}

/// Render a packet back to its wire form.
pub fn render_packet(packet: &Packet) -> String {
    format!("{}:{}", packet.tag, String::from_utf8_lossy(&packet.payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_packet_round_trips() {
        let packet = parse_packet("PING:hello").expect("parses");
        assert_eq!(packet.tag, "PING");
        assert_eq!(packet.payload, b"hello");
        assert_eq!(render_packet(&packet), "PING:hello");
    }

    #[test]
    fn parse_packet_rejects_missing_separator() {
        assert!(parse_packet("PING").is_err());
    }

    #[test]
    fn parse_packet_rejects_empty_tag() {
        assert!(parse_packet(":hello").is_err());
    }
}
