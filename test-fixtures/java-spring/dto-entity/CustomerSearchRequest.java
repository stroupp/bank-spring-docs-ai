package fixture.customer;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.List;

public class CustomerSearchRequest {
    @NotBlank
    @Size(max = 120)
    private String name;

    @Valid
    private List<AddressRequest> addresses;
}
